-- keybordy actions for Hammerspoon.
--
-- Over Bluetooth the board is a keyboard that taps one F13..F20 combo per key
-- or knob event (COMBOS below; keys8's K1..K8 send plain F13..F20, so it works
-- too). This module binds each combo to the action in
-- ~/.config/keybordy/keymap.json (seeded from host/keymap.default.json) and
-- serves the keymap editor on http://localhost:7373 (keybordy_web.lua). It
-- also runs host/voice.py, the talk bar's Mac side, and restarts it if it
-- exits. `just host-install` links this file into ~/.hammerspoon and adds
-- `require("keybordy")` to init.lua. Edits to host/hammerspoon/*.lua reload
-- Hammerspoon on save.

require("hs.ipc")  -- lets `hs -c` from a terminal talk to this instance

local HOME = os.getenv("HOME")
local SELF = hs.fs.pathToAbsolute(debug.getinfo(1, "S").source:sub(2))
local LUA_DIR = SELF:match("^(.*)/")
local HOST_DIR = LUA_DIR:match("^(.*)/hammerspoon$")
local CONFIG_DIR = HOME .. "/.config/keybordy"

package.path = LUA_DIR .. "/?.lua;" .. package.path

local M = {
  KEY_COUNT = 22,
  TALK_KEY = 21,             -- the talk bar: it records for host/voice.py, never sends a key
  REPLAY_KEY = 20,           -- says the last answer again, on the board: never sends a key
  YES_KEY = 22, NO_KEY = 19, -- answer Claude's yes/no questions on the board, normal keys otherwise
  KNOBS = { "E2", "E3" },    -- E1 stays on the board (volume, new session, power)
  TURNS = { "ccw", "cw", "push" },
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

local function cleanEntry(k)
  if type(k) ~= "table" then k = {} end
  return { label = type(k.label) == "string" and k.label or "", action = cleanAction(k.action) }
end

-- host/voice.py reads these from keymap.json on every take, with the same defaults.
local VOICE_FIELDS = {
  dir = "~", tools = "Read,Glob,Grep,WebSearch,WebFetch", model = "",
  voice = "me", language = "it", prompt = "",
}
M.VOICE_FIELDS = VOICE_FIELDS

-- Version 1 had keys only (K1..K8); they carry over as they are.
local function cleanKeymap(km)
  km = type(km) == "table" and km or {}
  local keys = {}
  for i = 1, M.KEY_COUNT do
    keys[i] = cleanEntry(type(km.keys) == "table" and km.keys[i])
  end
  keys[M.TALK_KEY] = { label = "Talk to Claude", action = { type = "none" } }
  keys[M.REPLAY_KEY] = { label = "Replay answer", action = { type = "none" } }
  local knobs = {}
  for _, e in ipairs(M.KNOBS) do
    local src = type(km.knobs) == "table" and type(km.knobs[e]) == "table" and km.knobs[e] or {}
    knobs[e] = {}
    for _, t in ipairs(M.TURNS) do knobs[e][t] = cleanEntry(src[t]) end
  end
  local voice = {}
  local src = type(km.voice) == "table" and km.voice or {}
  for field, default in pairs(VOICE_FIELDS) do
    voice[field] = type(src[field]) == "string" and src[field] or default
  end
  return { version = 2, keys = keys, knobs = knobs, voice = voice }
end

-- ── Slots ────────────────────────────────────────────────────────────────
--
-- A slot is anything with an action: "K1".."K22" (not K20/K21) and "E2.ccw",
-- "E2.cw", "E2.push", "E3...". COMBOS mirrors bleKey/bleKnob in
-- firmware/mp_pcb/mp_pcb.ino: change both together.

local function combo(id)
  local n = tonumber(id:match("^K(%d+)$"))
  if n then
    local group = (n - 1) // 8
    return ({ {}, { "shift" }, { "ctrl" } })[group + 1], "f" .. (13 + (n - 1) % 8)
  end
  local e, turn = id:match("^E(%d)%.(%a+)$")
  local t = ({ ccw = 0, cw = 1, push = 2 })[turn]
  return { "alt" }, "f" .. (13 + (tonumber(e) - 2) * 3 + t)
end
M.combo = combo

M.SLOTS = {}
for i = 1, M.KEY_COUNT do
  if i ~= M.TALK_KEY and i ~= M.REPLAY_KEY then table.insert(M.SLOTS, "K" .. i) end
end
for _, e in ipairs(M.KNOBS) do
  for _, t in ipairs(M.TURNS) do table.insert(M.SLOTS, e .. "." .. t) end
end

-- The keymap entry for a slot id, or nil.
function M.entry(id, km)
  km = km or M.keymap
  local n = tonumber(tostring(id):match("^K(%d+)$"))
  if n then return n ~= M.TALK_KEY and n ~= M.REPLAY_KEY and km.keys[n] or nil end
  local e, t = tostring(id):match("^(E%d)%.(%a+)$")
  return e and km.knobs[e] and km.knobs[e][t] or nil
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
  -- A keymap from before the knobs (version 1) gets the default knob actions.
  if type(km.knobs) ~= "table" then
    local ok2, def = pcall(hs.json.decode, M.readFile(HOST_DIR .. "/keymap.default.json") or "")
    if ok2 and def then km.knobs = def.knobs end
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

local function addEvent(ev)
  seq = seq + 1
  ev.id = seq
  ev.t = math.floor(hs.timer.secondsSinceEpoch() * 1000)
  table.insert(M.events, ev)
  if #M.events > MAX_EVENTS then table.remove(M.events, 1) end
  M.rev = M.rev + 1
  return ev
end

-- Runs slot id's action ("K3", "E2.cw"), or `draft` (an unsaved action from
-- the editor, with its label). source: "board" for a real press, "ui" for a
-- simulated one.
function M.fire(id, source, draft, draftLabel)
  local entry = M.entry(id)
  if not entry then return nil end
  local action = draft and cleanAction(draft) or entry.action
  local label = type(draftLabel) == "string" and draftLabel or entry.label
  local ev = addEvent({ key = id, source = source, type = action.type, label = label })

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
    hs.alert.show(id .. " is free: set it on localhost:7373", 1.2)
  elseif ev.ok == false then
    hs.alert.show(id .. " · " .. name .. " failed\n" .. (ev.error or ""), 2)
  else
    hs.alert.show(id .. " · " .. name, 0.6)
  end
  return ev
end

-- ── Voice (host/voice.py) ────────────────────────────────────────────────
--
-- Started here and restarted 5 s after it exits. Its "EV {json}" lines
-- become K21 events in the activity log; other lines are kept for the editor.

M.voice = { state = "stopped", log = {} }
local VOICE_LOG_LINES = 60
local voiceBuf, voiceEv = "", nil

local function voiceLine(line)
  local json = line:match("^EV (.*)$")
  if not json then
    table.insert(M.voice.log, line)
    if #M.voice.log > VOICE_LOG_LINES then table.remove(M.voice.log, 1) end
    M.rev = M.rev + 1
    return
  end
  local ok, e = pcall(hs.json.decode, json)
  if not ok or type(e) ~= "table" then return end
  if e.kind == "ready" then
    M.voice.state = "running"
  elseif e.kind == "take" then
    voiceEv = addEvent({ key = "K" .. M.TALK_KEY, source = "board", type = "voice", label = "listening…", pending = true })
  elseif e.kind == "heard" and voiceEv then
    voiceEv.label = e.text ~= "" and ("“" .. e.text .. "”") or "nothing heard"
    if e.text == "" then M.settle(voiceEv, false, "nothing heard") voiceEv = nil end
  elseif e.kind == "reply" and voiceEv then
    M.settle(voiceEv, true, nil, e.text)
    voiceEv = nil
  elseif e.kind == "error" then
    local ev = voiceEv or addEvent({ key = "K" .. M.TALK_KEY, source = "board", type = "voice", label = "voice" })
    M.settle(ev, false, e.text)
    voiceEv = nil
  elseif e.kind == "replay" then
    M.settle(addEvent({ key = "K" .. M.REPLAY_KEY, source = "board", type = "voice", label = "replay (from the Mac)" }), true, nil, e.text)
  elseif e.kind == "new" then
    M.settle(addEvent({ key = "K" .. M.TALK_KEY, source = "board", type = "voice", label = "new Claude session" }), true)
  end
  M.rev = M.rev + 1
end

function M.startVoice()
  if M.voice.task and M.voice.task:isRunning() then return end
  M.voice.state = "starting"
  M.voice.task = hs.task.new("/usr/bin/python3", function(code)
    M.voice.state = "stopped (exit " .. tostring(code) .. "), restarting"
    M.rev = M.rev + 1
    M.voice.timer = hs.timer.doAfter(5, M.startVoice)
  end, function(_, out, err)
    voiceBuf = voiceBuf .. (out or "") .. (err or "")
    for line in voiceBuf:gmatch("([^\n]*)\n") do voiceLine(line) end
    voiceBuf = voiceBuf:match("[^\n]*$")
    return true
  end, { "-u", HOST_DIR .. "/voice.py" })
  if not M.voice.task:start() then M.voice.state = "could not start /usr/bin/python3" end
end

function M.restartVoice()
  if M.voice.timer then M.voice.timer:stop() end
  local task = M.voice.task
  M.voice.task = nil
  if task and task:isRunning() then
    task:setCallback(nil)
    task:terminate()
  end
  hs.timer.doAfter(0.5, M.startVoice)
end

-- The MP's own layout and cap colors from layout/macropad.json: caps, mods
-- and the talk bar in their filament colors, knobs in the brand lime (the
-- printed ones are black, which would vanish on the dark page).
function M.layout()
  local raw = M.readFile(M.REPO_DIR .. "/layout/macropad.json")
  local ok, d = pcall(hs.json.decode, raw or "")
  if not ok or not d then return nil end
  local pal = d.finish and d.finish.palette or {}
  local function color(name, fallback) return pal[name] or fallback end
  local keys = {}
  for _, k in ipairs(d.keys or {}) do
    local finish = k.role == "ptt" and d.finish.ptt or k.role == "mod" and d.finish.mods or d.finish.keycaps
    table.insert(keys, { id = k.id, x = k.x, y = k.y, w = k.w, h = k.h, role = k.role, color = color(finish, "#f4f4f0") })
  end
  local encoders = {}
  for _, e in ipairs(d.encoders or {}) do table.insert(encoders, { id = e.id, color = "#d6ff1f" }) end
  return { keys = keys, encoders = encoders }
end

-- The F-key combo each slot taps, for the editor ("⇧F13").
function M.combos()
  local out = {}
  for _, id in ipairs(M.SLOTS) do
    local mods, key = combo(id)
    out[id] = { mods = mods, key = key }
  end
  return out
end

-- ── Start ────────────────────────────────────────────────────────────────

M.load()

for _, id in ipairs(M.SLOTS) do
  local mods, key = combo(id)
  M.hotkeys[id] = hs.hotkey.bind(mods, key, function() M.fire(id, "board") end)
end

M.startVoice()

M.web = require("keybordy_web")(M)

M.menubar = hs.menubar.new()
if M.menubar then
  M.menubar:setTitle("⌨︎")
  M.menubar:setTooltip("keybordy")
  M.menubar:setMenu(function()
    return {
      { title = "Open keymap editor", fn = function()
        -- The keybordy app (`just host-app`) if it is installed, else the browser.
        if not hs.application.launchOrFocus("keybordy") then hs.urlevent.openURL(M.web.url) end
      end },
      { title = "Reveal keymap.json", fn = function() hs.execute("open -R " .. string.format("%q", M.KEYMAP_PATH)) end },
      { title = "Voice: " .. M.voice.state, disabled = true },
      { title = "Restart voice service", fn = M.restartVoice },
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
