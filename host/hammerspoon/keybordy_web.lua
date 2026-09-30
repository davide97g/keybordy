-- The keymap editor: host/ui served on http://localhost:7373, plus a JSON API.
--
-- It can run shell commands, so it only answers on loopback, only for a Host
-- of localhost/127.0.0.1 (no DNS rebinding), and every /api call except icons
-- needs the token that index.html carries. Other sites cannot read that page
-- (no CORS), so they cannot get the token. The token lives in
-- ~/.config/keybordy/token so an open tab survives a reload.
--
--   GET  /api/state             keymap, colors, events, accessibility
--   GET  /api/events            events, rev, keymapRev: polled by the page
--   PUT  /api/keymap            save a whole keymap
--   POST /api/press/<n>         simulate a press: body {label?, action?} tests a draft
--   GET  /api/apps              installed apps
--   GET  /api/shortcuts         macOS Shortcuts by name
--   POST /api/accessibility     show the macOS Accessibility prompt
--   GET  /api/icon?path=<.app>  app icon PNG

local PORT = 7373

return function(kb)
  local UI_DIR = kb.HOST_DIR .. "/ui"
  local FRONTEND = kb.REPO_DIR .. "/sim/velxio/frontend"

  -- Static files: URL prefix -> folder. The editor's tokens, fonts and
  -- sticker are served from the simulator frontend, so the two stay in step.
  local STATIC = {
    ["/ui/"] = UI_DIR .. "/",
    ["/tokens/"] = FRONTEND .. "/src/tokens/",
    ["/fonts/"] = FRONTEND .. "/public/fonts/",
    ["/keybordy/"] = FRONTEND .. "/public/keybordy/",
  }
  local TYPES = {
    html = "text/html; charset=utf-8", css = "text/css; charset=utf-8",
    js = "text/javascript; charset=utf-8", woff2 = "font/woff2",
    png = "image/png", svg = "image/svg+xml",
  }

  local function token()
    local path = kb.CONFIG_DIR .. "/token"
    local t = kb.readFile(path)
    if t and #t >= 32 then return t end
    local bytes = {}
    for i = 1, 24 do bytes[i] = string.format("%02x", math.random(0, 255)) end
    t = table.concat(bytes)
    kb.writeFile(path, t)
    hs.execute("chmod 600 " .. string.format("%q", path))
    return t
  end
  math.randomseed(os.time() + math.floor(hs.timer.absoluteTime() % 1e6))
  local TOKEN = token()

  local function json(data, code)
    return hs.json.encode(data), code or 200, { ["Content-Type"] = "application/json", ["Cache-Control"] = "no-store" }
  end

  local function fail(code, msg)
    return json({ error = msg }, code)
  end

  local function header(headers, name)
    for k, v in pairs(headers or {}) do
      if k:lower() == name then return v end
    end
  end

  local function query(path)
    local q = {}
    for k, v in (path:match("%?(.*)$") or ""):gmatch("([^&=]+)=([^&]*)") do
      q[k] = v:gsub("+", " "):gsub("%%(%x%x)", function(h) return string.char(tonumber(h, 16)) end)
    end
    return q
  end

  -- The logo sticker's markup, cut from the simulator's boot splash so there
  -- is no third copy of the SVG.
  local function sticker()
    local html = kb.readFile(FRONTEND .. "/index.html") or ""
    return html:match('(<svg class="kbs".-</svg>)') or ""
  end

  local function index()
    local html = kb.readFile(UI_DIR .. "/index.html")
    if not html then return fail(500, "host/ui/index.html missing") end
    html = html:gsub("__TOKEN__", TOKEN):gsub("<!%-%- STICKER %-%->", function() return sticker() end)
    return html, 200, { ["Content-Type"] = TYPES.html, ["Cache-Control"] = "no-store" }
  end

  local function static(path)
    for prefix, dir in pairs(STATIC) do
      local name = path:sub(1, #prefix) == prefix and path:sub(#prefix + 1)
      if name and name:match("^[%w_.-]+$") and not name:find("%.%.") then
        local data = kb.readFile(dir .. name)
        if data then
          return data, 200, {
            ["Content-Type"] = TYPES[name:match("%.(%w+)$") or ""] or "application/octet-stream",
            ["Cache-Control"] = "no-cache",
          }
        end
      end
    end
    return fail(404, "not found")
  end

  local apps
  local function listApps()
    if apps then return apps end
    apps = {}
    local seen = {}
    local dirs = { "/Applications", "/Applications/Utilities", os.getenv("HOME") .. "/Applications",
      "/System/Applications", "/System/Applications/Utilities" }
    for _, dir in ipairs(dirs) do
      local ok, iter, state = pcall(hs.fs.dir, dir)
      if ok and iter then
        for file in iter, state do
          local name = file:match("^(.*)%.app$")
          if name and not seen[name] then
            seen[name] = true
            table.insert(apps, { name = name, path = dir .. "/" .. file })
          end
        end
      end
    end
    table.sort(apps, function(a, b) return a.name:lower() < b.name:lower() end)
    return apps
  end

  local icons = {}
  local function icon(path)
    if not path or not path:match("%.app$") then return fail(400, "not an app") end
    if not icons[path] then
      local img = hs.image.iconForFile(path)
      local url = img and img:setSize({ w = 64, h = 64 }):encodeAsURLString(false, "PNG")
      icons[path] = url and hs.base64.decode(url:match(",(.*)$")) or ""
    end
    if icons[path] == "" then return fail(404, "no icon") end
    return icons[path], 200, { ["Content-Type"] = "image/png", ["Cache-Control"] = "max-age=86400" }
  end

  local function shortcuts()
    local out, ok = hs.execute("/usr/bin/shortcuts list")
    local names = {}
    if ok then
      for line in out:gmatch("[^\n]+") do table.insert(names, line) end
    end
    return names
  end

  local function events()
    return { rev = kb.rev, events = kb.events, keymapRev = kb.keymapRev, accessibility = hs.accessibilityState() }
  end

  local function state()
    local s = events()
    s.keymap = kb.keymap
    s.colors = kb.colors()
    s.keymapPath = kb.KEYMAP_PATH:gsub("^" .. os.getenv("HOME"), "~")
    s.mediaKeys = {}
    for k in pairs(kb.MEDIA_KEYS) do table.insert(s.mediaKeys, k) end
    table.sort(s.mediaKeys)
    return s
  end

  local function decode(body)
    local ok, data = pcall(hs.json.decode, body or "")
    if ok and type(data) == "table" then return data end
  end

  local ORIGINS = {
    ["http://localhost:" .. PORT] = true,
    ["http://127.0.0.1:" .. PORT] = true,
  }

  local function route(method, path, headers, body)
    local host = header(headers, "host")
    if host ~= "localhost:" .. PORT and host ~= "127.0.0.1:" .. PORT then
      return fail(403, "bad host")
    end
    local origin = header(headers, "origin")
    if origin and not ORIGINS[origin] then return fail(403, "bad origin") end

    local bare = path:match("^[^?]*")
    if bare == "/" and method == "GET" then return index() end
    if bare == "/api/icon" and method == "GET" then return icon(query(path).path) end
    if bare:sub(1, 5) ~= "/api/" then
      if method ~= "GET" then return fail(405, "method not allowed") end
      return static(bare)
    end

    if header(headers, "x-keybordy-token") ~= TOKEN then return fail(401, "bad token") end

    if bare == "/api/state" and method == "GET" then return json(state()) end
    if bare == "/api/events" and method == "GET" then return json(events()) end
    if bare == "/api/apps" and method == "GET" then return json(listApps()) end
    if bare == "/api/shortcuts" and method == "GET" then return json(shortcuts()) end
    if bare == "/api/accessibility" and method == "POST" then
      return json({ accessibility = hs.accessibilityState(true) })
    end
    if bare == "/api/keymap" and method == "PUT" then
      local km = decode(body)
      if not km then return fail(400, "body is not JSON") end
      kb.save(km)
      return json({ keymap = kb.keymap })
    end
    local n = tonumber(bare:match("^/api/press/(%d+)$"))
    if n and method == "POST" then
      if n < 1 or n > kb.KEY_COUNT then return fail(404, "no key " .. n) end
      local data = decode(body) or {}
      -- Let the response go out first: an action that opens an app would
      -- otherwise stall the reply behind it.
      hs.timer.doAfter(0, function() kb.fire(n, "ui", data.action, data.label) end)
      return json({ ok = true })
    end
    return fail(404, "not found")
  end

  local server = hs.httpserver.new(false, false)
  server:setInterface("localhost")
  server:setPort(PORT)
  server:setName("keybordy")
  server:setCallback(function(method, path, headers, body)
    local ok, resBody, code, resHeaders = pcall(route, method, path, headers, body)
    if ok then return resBody, code, resHeaders end
    return hs.json.encode({ error = tostring(resBody) }), 500, { ["Content-Type"] = "application/json" }
  end)
  server:start()

  return { server = server, url = "http://localhost:" .. PORT .. "/" }
end
