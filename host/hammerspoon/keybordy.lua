-- keybordy actions for Hammerspoon.
--
-- Over Bluetooth the board is a keyboard: K1..K8 press F13..F20. This module
-- binds each of those keys to the action in ~/.config/keybordy/keymap.json
-- (seeded from host/keymap.default.json) and serves the keymap editor on
-- http://localhost:7373 (keybordy_web.lua). `just host-install` links this
-- file into ~/.hammerspoon and adds `require("keybordy")` to init.lua.
-- Edits to host/hammerspoon/*.lua reload Hammerspoon on save.

require("hs.ipc")  -- lets `hs -c` from a terminal talk to this instance

local HOME = os.getenv("HOME")
local SELF = hs.fs.pathToAbsolute(debug.getinfo(1, "S").source:sub(2))
local LUA_DIR = SELF:match("^(.*)/")
local HOST_DIR = LUA_DIR:match("^(.*)/hammerspoon$")
local CONFIG_DIR = HOME .. "/.config/keybordy"

package.path = LUA_DIR .. "/?.lua;" .. package.path

local M = {
  KEY_COUNT = 8,
  HOST_DIR = HOST_DIR,
  REPO_DIR = HOST_DIR:match("^(.*)/host$"),
  CONFIG_DIR = CONFIG_DIR,
  KEYMAP_PATH = CONFIG_DIR .. "/keymap.json",
  events = {},  -- newest last, at most MAX_EVENTS
  rev = 0,      -- bumped on every event change, so pollers know to redraw
  keymapRev = 0, -- bumped on every keymap load or save
  hotkeys = {},
}
local MAX_EVENTS = 40

-- ── Files ────────────────────────────────────────────────────────────────

function M.readFile(path)
  local f = io.open(path, "rb")
  if not f then return nil end
  local data = f:read("a")
  f:close()
  return data
end

function M.writeFile(path, data)
  local tmp = path .. ".tmp"
  local f = assert(io.open(tmp, "wb"))
  f:write(data)
  f:close()
  assert(os.rename(tmp, path))
end

local function expand(path)
  return (path:gsub("^~", HOME))
end

-- ── Actions ──────────────────────────────────────────────────────────────
--
-- Each runner gets the action and its event, and returns ok, error. Runners
-- that finish later (shell, shortcut) mark the event pending and call
-- M.settle when done.

local function needsAccessibility()
  if hs.accessibilityState() then return nil end
  return "needs Accessibility: allow Hammerspoon in System Settings > Privacy & Security"
end

-- AppleScript string literal.
local function quote(s)
  return '"' .. s:gsub('\\', '\\\\'):gsub('"', '\\"') .. '"'
end

-- Runs argv and records its output on the event.
local function runTask(ev, path, args)
  ev.pending = true
  local task = hs.task.new(path, function(code, out, err)
    local text = (out or "") .. (err or "")
    M.settle(ev, code == 0, code ~= 0 and ("exit " .. code) or nil, text)
  end, args)
  if not task or not task:start() then return false, "could not start " .. path end
  return true
end

local MEDIA_KEYS = {
  PLAY = true, NEXT = true, PREVIOUS = true, FAST = true, REWIND = true,
  SOUND_UP = true, SOUND_DOWN = true, MUTE = true,
  BRIGHTNESS_UP = true, BRIGHTNESS_DOWN = true,
  ILLUMINATION_UP = true, ILLUMINATION_DOWN = true,
}
M.MEDIA_KEYS = MEDIA_KEYS

local MODS = { cmd = true, alt = true, ctrl = true, shift = true, fn = true }

local runners = {}

runners.none = function() return true end

runners.app = function(a)
  local target = a.path ~= "" and a.path or a.app
  if target == "" then return false, "no app chosen" end
  if hs.application.launchOrFocus(target) then return true end
  return false, "could not open " .. target
end

-- Ghostty 1.3+ is scriptable: the command goes in as typed input, so the
-- shell stays open when it exits. The first run asks to let Hammerspoon
-- control Ghostty.
runners.terminal = function(a)
  local script = string.format([[
    tell application "Ghostty"
      activate
      set cfg to new surface configuration
      set initial working directory of cfg to %s
      set initial input of cfg to %s
      new window with configuration cfg
    end tell]], quote(expand(a.dir ~= "" and a.dir or "~")),
    quote(a.command ~= "" and (a.command .. "\n") or ""))
  local ok, _, err = hs.osascript.applescript(script)
  if ok then return true end
  return false, "Ghostty: " .. ((err and err.NSAppleScriptErrorMessage) or hs.inspect(err))
end

-- Login shell, so PATH matches the terminal's.
runners.shell = function(a, ev)
  if a.command == "" then return false, "no command" end
  return runTask(ev, "/bin/zsh", { "-lc", a.command })
end

runners.url = function(a)
  if not a.url:match("^%a[%w+.-]*:") then return false, "not a URL: " .. a.url end
  if hs.urlevent.openURL(a.url) then return true end
  return false, "could not open " .. a.url
end

runners.keys = function(a)
  local err = needsAccessibility()
  if err then return false, err end
  if not hs.keycodes.map[a.key] then return false, "unknown key " .. a.key end
  hs.eventtap.keyStroke(a.mods, a.key, 20000)
  return true
end

runners.text = function(a)
  local err = needsAccessibility()
  if err then return false, err end
  hs.eventtap.keyStrokes(a.text)
  return true
end

runners.shortcut = function(a, ev)
  if a.name == "" then return false, "no shortcut chosen" end
  return runTask(ev, "/usr/bin/shortcuts", { "run", a.name })
end

runners.media = function(a)
  local err = needsAccessibility()
  if err then return false, err end
  if not MEDIA_KEYS[a.key] then return false, "unknown media key " .. a.key end
  hs.eventtap.event.newSystemKeyEvent(a.key, true):post()
  hs.eventtap.event.newSystemKeyEvent(a.key, false):post()
  return true
end

-- The fields each action type keeps, with their defaults. Anything else in
-- the JSON is dropped on save.
local FIELDS = {
  none = {},
  app = { app = "", path = "" },
  terminal = { dir = "~", command = "" },
  shell = { command = "" },
  url = { url = "" },
  keys = { key = "", mods = {} },
  text = { text = "" },
  shortcut = { name = "" },
  media = { key = "PLAY" },
}

local function cleanAction(a)
  if type(a) ~= "table" or not FIELDS[a.type] then return { type = "none" } end
  local out = { type = a.type }
  for field, default in pairs(FIELDS[a.type]) do
    local v = a[field]
    if field == "mods" then
      out.mods = {}
      for _, m in ipairs(type(v) == "table" and v or {}) do
        if MODS[m] then table.insert(out.mods, m) end
      end
    else
      out[field] = type(v) == "string" and v or default
    end
  end
  return out
end
M.cleanAction = cleanAction

local function cleanKeymap(km)
  local keys = {}
  for i = 1, M.KEY_COUNT do
    local k = type(km) == "table" and type(km.keys) == "table" and km.keys[i] or {}
    if type(k) ~= "table" then k = {} end
    keys[i] = {
      label = type(k.label) == "string" and k.label or "",
      action = cleanAction(k.action),
    }
  end
  return { version = 1, keys = keys }
end

-- ── Keymap ───────────────────────────────────────────────────────────────

function M.load()
  local raw = M.readFile(M.KEYMAP_PATH)
  if not raw then
    hs.fs.mkdir(CONFIG_DIR)
    raw = assert(M.readFile(HOST_DIR .. "/keymap.default.json"))
    M.writeFile(M.KEYMAP_PATH, raw)
  end
  local ok, km = pcall(hs.json.decode, raw)
  if not ok or not km then
    hs.alert.show("keybordy: keymap.json is not valid JSON, using defaults")
    km = hs.json.decode(M.readFile(HOST_DIR .. "/keymap.default.json"))
  end
  M.keymap = cleanKeymap(km)
  M.keymapRev = M.keymapRev + 1
end

function M.save(km)
  M.keymap = cleanKeymap(km)
  M.keymapRev = M.keymapRev + 1
  M.writeFile(M.KEYMAP_PATH, hs.json.encode(M.keymap, true) .. "\n")
end

-- ── Presses ──────────────────────────────────────────────────────────────

function M.settle(ev, ok, err, output)
  ev.pending = nil
  ev.ok = ok
  ev.error = err
  if output and output ~= "" then ev.output = output:sub(1, 4000) end
  M.rev = M.rev + 1
end

local seq = 0

-- Runs key i's action, or `draft` (an unsaved action from the editor, with
-- its label). source: "board" for a real press, "ui" for a simulated one.
function M.fire(i, source, draft, draftLabel)
  local entry = M.keymap.keys[i]
  local action = draft and cleanAction(draft) or entry.action
  local label = type(draftLabel) == "string" and draftLabel or entry.label
  seq = seq + 1
  local ev = {
    id = seq, key = i, source = source, type = action.type,
    label = label, t = math.floor(hs.timer.secondsSinceEpoch() * 1000),
  }
  table.insert(M.events, ev)
  if #M.events > MAX_EVENTS then table.remove(M.events, 1) end

  local ok, res, err = pcall(runners[action.type], action, ev)
  if not ok then
    M.settle(ev, false, tostring(res))
  elseif not ev.pending then
    M.settle(ev, res, err)
  else
    M.rev = M.rev + 1
  end

  local name = label ~= "" and label or action.type
  if action.type == "none" then
    hs.alert.show("K" .. i .. " is free: set it on localhost:7373", 1.2)
  elseif ev.ok == false then
    hs.alert.show("K" .. i .. " · " .. name .. " failed\n" .. (ev.error or ""), 2)
  else
    hs.alert.show("K" .. i .. " · " .. name, 0.6)
  end
  return ev
end

-- Button colors from the Wokwi diagram (parts labeled K1..K8), so the editor
-- paints the same caps as the simulator.
function M.colors()
  local colors = {}
  local raw = M.readFile(M.REPO_DIR .. "/firmware/keys8/diagram.json")
  local ok, d = pcall(hs.json.decode, raw or "")
  if ok and d and d.parts then
    for _, p in ipairs(d.parts) do
      local n = p.attrs and p.attrs.label and tonumber(p.attrs.label:match("^K(%d+)$"))
      if n and p.attrs.color then colors[n] = p.attrs.color end
    end
  end
  for i = 1, M.KEY_COUNT do colors[i] = colors[i] or "#d6ff1f" end
  return colors
end

-- ── Start ────────────────────────────────────────────────────────────────

M.load()

for i = 1, M.KEY_COUNT do
  M.hotkeys[i] = hs.hotkey.bind({}, "f" .. (12 + i), function() M.fire(i, "board") end)
end

M.web = require("keybordy_web")(M)

M.menubar = hs.menubar.new()
if M.menubar then
  M.menubar:setTitle("⌨︎")
  M.menubar:setTooltip("keybordy")
  M.menubar:setMenu(function()
    return {
      { title = "Open keymap editor", fn = function() hs.urlevent.openURL(M.web.url) end },
      { title = "Reveal keymap.json", fn = function() hs.execute("open -R " .. string.format("%q", M.KEYMAP_PATH)) end },
      { title = "-" },
      { title = "Reload", fn = hs.reload },
    }
  end)
end

-- Reload when a module changes. Watches the folder, since editors often save
-- by replacing the file.
M.watcher = hs.pathwatcher.new(LUA_DIR, function(paths)
  for _, p in ipairs(paths) do
    if p:match("%.lua$") then return hs.reload() end
  end
end):start()

-- keymap.json edited by hand: pick it up without a reload.
M.keymapWatcher = hs.pathwatcher.new(CONFIG_DIR, function(paths)
  for _, p in ipairs(paths) do
    if p:match("/keymap%.json$") then return M.load() end
  end
end):start()

hs.alert.show("keybordy loaded", 0.8)

return M
