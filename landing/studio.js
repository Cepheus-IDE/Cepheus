// Cepheus Studio: chat with Nemotron and generate images (FLUX.2 klein), short videos and music loops.
// Everything goes through the keyless proxy at api.cepheus.codes; video and music are assembled in the browser.
(function () {
  "use strict";
  var root = document.getElementById("st");
  if (!root) return;

  var isLocal = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  var qApi = new URLSearchParams(location.search).get("api");
  var API = isLocal && qApi ? qApi : "https://api.cepheus.codes/v1";
  var FAST = "nvidia/nemotron-3.5-lightning-30b-a3b";
  var BIG = "nvidia/nemotron-3-ultra-550b-a55b";
  var CHAT = "nvidia/nemotron-3.5-super-vl-120b-a12b"; // best balance of speed and accuracy for conversation

  var log = document.getElementById("st-log");
  var empty = document.getElementById("st-empty");
  var form = document.getElementById("st-form");
  var input = document.getElementById("st-text");
  var send = document.getElementById("st-send");
  var aspSel = document.getElementById("st-asp");
  var aspWrap = document.getElementById("st-asp-wrap");
  var hint = document.getElementById("st-hint");
  var mode = "auto";
  var busy = false;
  var history = []; // {role, content}, text only

  var ICON = {
    download: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/></svg>',
    again: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>',
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l13-7.5z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>'
  };

  // ---------------------------------------------------------------- prompts
  var SYS_CHAT = [
    "You are Cepheus Studio, the assistant on cepheus.codes. Cepheus is a free, open-source (MIT) AI code editor for Windows, macOS and Linux, with a CLI and a web version; its agent plans, edits, runs and checks code, and free NVIDIA Nemotron models are built in with no API key.",
    "Facts you may rely on (do not invent other Cepheus features, commands or settings; if unsure, point to cepheus.codes/docs.html):",
    "- The agent works in a loop: it makes a plan, reads the relevant files, edits them (you see each diff and can approve or reject it), runs commands such as tests or builds in the terminal, reads the output and errors, fixes what failed and runs the checks again until they pass, then summarizes what changed. Open it with Ctrl+L. Approval modes go from asking before every edit to Auto-edit.",
    "- Projects can add an AGENTS.md file with their own rules for the agent.",
    "- The editor has language servers, a debugger, a test explorer, a three-way merge editor, an integrated browser, Git, a database client with ER diagrams and AI-written SQL, a Docker view, and extension bridges.",
    "- Free NVIDIA Nemotron models with automatic fallback; you can also add your own keys for other providers. The Rust core uses about 10 MB of memory. MIT license, no telemetry.",
    "- CLI: npm i -g cepheus-ide, then `cepheus` for an interactive session, `cepheus \"fix the failing test\"` for one task, `cepheus web .` for the full editor in a browser. Web version: cepheus.codes/app. Downloads: cepheus.codes (Windows, macOS, Linux).",
    "Reply in the user's language. Be concise and concrete. Markdown is allowed: **bold**, lists, `code`, fenced code blocks.",
    "This studio can also make media. When the user asks you to create, draw, generate or make an image, picture, photo, illustration or logo-like art, a video, clip or animation, or music, a song, a beat or a loop, do not describe it in text. Instead reply with ONLY one JSON object on a single line, nothing else:",
    '{"action":"image","prompt":"<detailed English prompt for an image model: subject, setting, style, lighting, camera>","aspect":"16:9|1:1|9:16"}',
    '{"action":"video","brief":"<what the video should show, in English>","aspect":"16:9|9:16"}',
    '{"action":"music","brief":"<mood, genre, tempo and instruments, in English>"}',
    "Music is instrumental only; if lyrics or vocals are requested, still reply with the music JSON.",
    "Refuse in plain text, without JSON: sexual content, anything involving minors in a sexual or harmful way, the likeness of real people, gore, hate, and trademarked logos or characters.",
    "Never give price predictions or investment advice about any token. About $CEPHEUS: the only official contract address is the one shown on cepheus.codes."
  ].join("\n");

  var SYS_IMAGE = "Rewrite the user's request as one detailed English prompt for an image model (subject, setting, style, lighting, camera, composition). Do not add text or logos to the image. Reply with ONLY JSON: {\"prompt\":\"...\",\"aspect\":\"16:9|1:1|9:16\"}. Choose the aspect that suits the subject. If the request is sexual, involves real people's likeness, gore or trademarked characters, reply {\"refuse\":\"<short reason in the user's language>\"}.";

  var SYS_VIDEO = [
    "You plan a short video made of 4 shots. Each shot becomes one AI-generated still that is slowly animated with captions and music.",
    "Reply with ONLY JSON, no prose:",
    '{"title":"<2-5 words, user\'s language>","look":"<shared visual style for every shot, English, 8-16 words>","scenes":[{"prompt":"<English image prompt for this shot: subject, action, setting, camera angle>","caption":"<on-screen text, max 7 words, user\'s language>"},... exactly 4],"music":"<music brief: mood, genre, tempo>"}',
    "Shots should tell a small story from start to end and keep the same characters and setting. No text or logos inside the images.",
    'If the request is sexual, involves real people\'s likeness, gore or trademarked characters, reply {"refuse":"<short reason in the user\'s language>"}.'
  ].join("\n");

  var SYS_MUSIC = [
    "You compose short instrumental loops. Reply with ONLY one JSON object, no prose, no code fences:",
    '{"title":string,"bpm":60-160,"chords":[4 or 8 chord symbols such as "Am","Fmaj7","C","G7","Dm9","Esus4"],"drums":"lofi|house|trap|rock|ambient|none","bass":"root|octave|walking|none","lead":"sine|square|saw|pluck|bell","pad":true|false,"arp":"up|down|none","melody":[[beat,lengthInBeats,"E5"],...]}',
    "One chord lasts one bar of 4/4. The melody covers 8 bars (beats 0 to 31), has 14 to 32 notes between C3 and C6, uses the notes of the chords, and has a memorable motif that repeats with variation."
  ].join("\n");

  // ---------------------------------------------------------------- UI helpers
  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function stick() { log.scrollTop = log.scrollHeight; }
  function nearBottom() { return log.scrollHeight - log.scrollTop - log.clientHeight < 140; }

  function md(src) {
    var blocks = [];
    var s = String(src).replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)(```|$)/g, function (_, code) { blocks.push(code.replace(/\n$/, "")); return "\u0000" + (blocks.length - 1) + "\u0000"; });
    s = esc(s);
    var inline = function (t) {
      return t.replace(/`([^`\n]+)`/g, "<code>$1</code>").replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>").replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
        .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener nofollow">$1</a>');
    };
    var out = [], list = null;
    s.split(/\n/).forEach(function (line) {
      var m = /^\s*(?:[-*•]|(\d+)[.)])\s+(.*)$/.exec(line);
      if (m) {
        var type = m[1] ? "ol" : "ul";
        if (!list || list.type !== type) { if (list) out.push("</" + list.type + ">"); list = { type: type }; out.push("<" + type + ">"); }
        out.push("<li>" + inline(m[2]) + "</li>");
        return;
      }
      if (list) { out.push("</" + list.type + ">"); list = null; }
      if (/^\u0000\d+\u0000$/.test(line.trim())) { out.push(line.trim()); return; }
      if (line.trim()) out.push("<p>" + inline(line.replace(/^#{1,6}\s+/, "")) + "</p>");
    });
    if (list) out.push("</" + list.type + ">");
    return out.join("").replace(/\u0000(\d+)\u0000/g, function (_, i) { return "<pre><code>" + esc(blocks[+i]) + "</code></pre>"; });
  }

  function addUser(text) {
    if (empty) { empty.remove(); empty = null; }
    var m = el("div", "smsg user");
    m.appendChild(el("div", "txt")).textContent = text;
    log.appendChild(m);
    stick();
  }
  function addBot() {
    var m = el("div", "smsg bot");
    m.appendChild(el("div", "who", "Cepheus"));
    var body = el("div", "txt", '<span class="typing" aria-label="Thinking"><i></i><i></i><i></i></span>');
    m.appendChild(body);
    log.appendChild(m);
    stick();
    return { msg: m, body: body };
  }
  function errorCard(where, message, retry) {
    var c = el("div", "card");
    var e = el("div", "card-err");
    e.appendChild(el("span", "", esc(message)));
    if (retry) {
      var b = el("div", "card-acts");
      var btn = el("button", "", ICON.again + "Try again");
      btn.type = "button";
      btn.onclick = function () { c.remove(); retry(); };
      b.appendChild(btn);
      e.appendChild(b);
    }
    c.appendChild(e);
    where.appendChild(c);
    stick();
  }
  function setBusy(b) {
    busy = b;
    send.disabled = b || !input.value.trim();
    root.classList.toggle("busy", b);
  }
  function saveAs(url, name) { var a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); }
  function slug(s) { return (String(s || "cepheus").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "cepheus").slice(0, 40); }

  // ---------------------------------------------------------------- API
  function apiError(r, j) {
    var msg = (j && j.error && (j.error.message || j.error)) || (r.status === 429 ? "Too many requests, wait a moment." : "The service had a problem (" + r.status + "). Please try again.");
    return new Error(typeof msg === "string" ? msg : "Request failed");
  }

  function chat(messages, opts) {
    opts = opts || {};
    var body = {
      model: opts.model || FAST, messages: messages, temperature: opts.temperature == null ? 0.7 : opts.temperature,
      max_tokens: opts.maxTokens || 1600, stream: !!opts.onDelta, chat_template_kwargs: { enable_thinking: false }
    };
    return fetch(API + "/chat/completions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: opts.signal })
      .then(function (r) {
        if (!r.ok) return r.json().catch(function () { return null; }).then(function (j) { throw apiError(r, j); });
        if (!opts.onDelta) return r.json().then(function (j) { var m = j.choices && j.choices[0] && j.choices[0].message; return (m && m.content) || ""; });
        var reader = r.body.getReader(), dec = new TextDecoder(), buf = "", text = "";
        function pump() {
          return reader.read().then(function (x) {
            if (x.done) return text;
            buf += dec.decode(x.value, { stream: true });
            var lines = buf.split("\n");
            buf = lines.pop();
            lines.forEach(function (line) {
              line = line.trim();
              if (line.indexOf("data:") !== 0) return;
              var data = line.slice(5).trim();
              if (data === "[DONE]") return;
              try {
                var d = JSON.parse(data).choices[0].delta;
                if (d && d.content) { text += d.content; opts.onDelta(text); }
              } catch (e) { /* keep-alive or partial line */ }
            });
            return pump();
          });
        }
        return pump();
      })
      .catch(function (e) {
        // One retry on the larger model when the fast one is unavailable.
        if (!opts.retried && (opts.model || FAST) !== BIG &&!/limit|Too many/i.test(e.message)) {
          return chat(messages, Object.assign({}, opts, { model: BIG, retried: true }));
        }
        throw e;
      });
  }

  function parseJSON(text) {
    var s = String(text || "").replace(/```(?:json)?/gi, "").trim();
    var a = s.indexOf("{"), b = s.lastIndexOf("}");
    if (a < 0 || b <= a) return null;
    try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
  }
  function chatJSON(system, user, maxTokens) {
    var msgs = [{ role: "system", content: system }, { role: "user", content: user }];
    return chat(msgs, { temperature: 0.8, maxTokens: maxTokens || 1500 }).then(function (t) {
      var j = parseJSON(t);
      if (j) return j;
      return chat(msgs, { temperature: 0.4, maxTokens: maxTokens || 1500 }).then(function (t2) {
        var j2 = parseJSON(t2);
        if (!j2) throw new Error("The model returned something unexpected. Please try again.");
        return j2;
      });
    });
  }

  var SIZE = { "16:9": "1344x768", "1:1": "1024x1024", "9:16": "768x1344" };
  function genImage(prompt, aspect) {
    return fetch(API + "/images/generations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: prompt, size: SIZE[aspect] || SIZE["1:1"] }) })
      .then(function (r) { return r.json().catch(function () { return null; }).then(function (j) { if (!r.ok || !j || !j.data) throw apiError(r, j); return j.data[0]; }); })
      .then(function (d) {
        var bin = atob(d.b64_json), arr = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        var blob = new Blob([arr], { type: d.mime_type || "image/jpeg" });
        return { blob: blob, url: URL.createObjectURL(blob), width: d.width, height: d.height };
      });
  }

  function pickAspect(fromModel, fallback) {
    var forced = aspSel.value;
    if (forced !== "auto") return forced;
    return SIZE[fromModel] ? fromModel : fallback;
  }

  // ---------------------------------------------------------------- flows
  function run(text) {
    addUser(text);
    history.push({ role: "user", content: text });
    var m = mode;
    setBusy(true);
    var done = function () { setBusy(false); input.focus({ preventScroll: true }); };
    var job;
    if (m === "image") job = imageFlow(text, null);
    else if (m === "video") job = videoFlow(text, null);
    else if (m === "music") job = musicFlow(text);
    else job = chatFlow(m === "auto");
    Promise.resolve(job).then(done, done);
  }

  function chatFlow(allowMedia) {
    var bot = addBot();
    var ctx = history.slice(-12);
    var msgs = [{ role: "system", content: allowMedia ? SYS_CHAT : SYS_CHAT.split("\nThis studio can also make media.")[0] + "\nReply in text only." }].concat(ctx);
    var shown = "";
    return chat(msgs, {
      model: CHAT, maxTokens: 2000,
      onDelta: function (t) {
        var lead = t.replace(/^\s+/, "");
        if (allowMedia && (lead[0] === "{" || lead.indexOf("```") === 0)) return; // likely a media action: wait for the end
        if (t === shown) return;
        shown = t;
        var follow = nearBottom();
        bot.body.innerHTML = md(t);
        if (follow) stick();
      }
    }).then(function (t) {
      var lead = String(t).trim();
      var act = allowMedia && /^(\{|```)/.test(lead) ? parseJSON(lead) : null;
      if (act && act.action) {
        bot.msg.remove();
        if (act.action === "image") return imageFlow(null, act);
        if (act.action === "video") return videoFlow(act.brief || "", act);
        if (act.action === "music") return musicFlow(act.brief || "");
      }
      bot.body.innerHTML = md(t || "…");
      history.push({ role: "assistant", content: t });
      stick();
    }).catch(function (e) {
      bot.body.innerHTML = "";
      errorCard(bot.msg, e.message, function () { bot.msg.remove(); setBusy(true); chatFlow(allowMedia).then(function () { setBusy(false); }); });
    });
  }

  // Image ---------------------------------------------------------------
  function imageFlow(text, act) {
    var bot = addBot();
    var stagePrompt = act ? Promise.resolve(act) : chatJSON(SYS_IMAGE, text, 600);
    return stagePrompt.then(function (p) {
      if (p.refuse) { bot.body.innerHTML = md(p.refuse); history.push({ role: "assistant", content: p.refuse }); return; }
      var aspect = pickAspect(p.aspect, "1:1");
      bot.body.remove();
      return imageCard(bot.msg, p.prompt, aspect);
    }).catch(function (e) {
      bot.body.innerHTML = "";
      errorCard(bot.msg, e.message, function () { bot.msg.remove(); setBusy(true); imageFlow(text, act).then(function () { setBusy(false); }); });
    });
  }

  function imageCard(where, prompt, aspect) {
    var card = el("div", "card" + (aspect === "9:16" ? " tall" : ""));
    var media = el("div", "card-media loading");
    media.style.aspectRatio = aspect.replace(":", " / ");
    media.appendChild(el("span", "stage", "Drawing with FLUX.2"));
    card.appendChild(media);
    var body = el("div", "card-body");
    body.appendChild(el("p", "card-meta", esc(prompt)));
    card.appendChild(body);
    where.appendChild(card);
    stick();
    return genImage(prompt, aspect).then(function (img) {
      media.classList.remove("loading");
      media.innerHTML = "";
      var im = new Image();
      im.alt = prompt;
      im.src = img.url;
      media.appendChild(im);
      var acts = el("div", "card-acts");
      var dl = el("button", "primary", ICON.download + "Download");
      dl.type = "button";
      dl.onclick = function () { saveAs(img.url, "cepheus-" + slug(prompt) + ".jpg"); };
      var again = el("button", "", ICON.again + "Another one");
      again.type = "button";
      again.onclick = function () { if (busy) return; setBusy(true); imageCard(where, prompt, aspect).then(function () { setBusy(false); }); };
      acts.appendChild(dl); acts.appendChild(again);
      body.appendChild(acts);
      history.push({ role: "assistant", content: "[Generated an image: " + prompt + "]" });
      stick();
    }).catch(function (e) {
      card.remove();
      errorCard(where, e.message, function () { setBusy(true); imageCard(where, prompt, aspect).then(function () { setBusy(false); }); });
    });
  }

  // Music ---------------------------------------------------------------
  function musicFlow(brief, seconds) {
    var bot = addBot();
    bot.body.innerHTML = '<span class="typing" aria-label="Composing"><i></i><i></i><i></i></span>';
    return composeSong(brief).then(function (song) {
      bot.body.remove();
      return musicCard(bot.msg, song, seconds || 32);
    }).catch(function (e) {
      bot.body.innerHTML = "";
      errorCard(bot.msg, e.message, function () { bot.msg.remove(); setBusy(true); musicFlow(brief, seconds).then(function () { setBusy(false); }); });
    });
  }

  function composeSong(brief) {
    return chatJSON(SYS_MUSIC, brief || "a calm loop", 1800).then(sanitizeSong);
  }

  function musicCard(where, song, seconds) {
    var card = el("div", "card");
    var body = el("div", "card-body");
    body.appendChild(el("p", "card-title", esc(song.title)));
    var chips = el("div", "chips");
    [song.bpm + " BPM"].concat(song.chords.slice(0, 8), [song.drums + " drums", song.lead + " lead"]).forEach(function (c) { chips.appendChild(el("span", "", esc(c))); });
    body.appendChild(chips);
    var wave = el("canvas", "wave");
    var player = el("div", "player");
    var play = el("button", "play", ICON.play);
    play.type = "button";
    play.setAttribute("aria-label", "Play");
    var time = el("span", "time", "rendering…");
    player.appendChild(play);
    player.appendChild(wave);
    player.appendChild(time);
    body.appendChild(player);
    card.appendChild(body);
    where.appendChild(card);
    stick();
    return renderSong(song, seconds).then(function (buf) {
      var wav = encodeWAV(buf);
      var url = URL.createObjectURL(wav);
      var audio = new Audio(url);
      var fmt = function (s) { s = Math.max(0, Math.floor(s)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };
      time.textContent = "0:00 / " + fmt(buf.duration);
      var peaks = drawWave(wave, buf, 0);
      play.onclick = function () { if (audio.paused) audio.play(); else audio.pause(); };
      audio.onplay = function () { play.innerHTML = ICON.pause; play.setAttribute("aria-label", "Pause"); tick(); };
      audio.onpause = audio.onended = function () { play.innerHTML = ICON.play; play.setAttribute("aria-label", "Play"); };
      function tick() {
        drawWave(wave, buf, audio.currentTime / buf.duration, peaks);
        time.textContent = fmt(audio.currentTime) + " / " + fmt(buf.duration);
        if (!audio.paused) requestAnimationFrame(tick);
      }
      wave.onclick = function (e) { var r = wave.getBoundingClientRect(); audio.currentTime = (e.clientX - r.left) / r.width * buf.duration; tick(); };
      var acts = el("div", "card-acts");
      var dl = el("button", "primary", ICON.download + "Download WAV");
      dl.type = "button";
      dl.onclick = function () { saveAs(url, "cepheus-" + slug(song.title) + ".wav"); };
      acts.appendChild(dl);
      body.appendChild(acts);
      history.push({ role: "assistant", content: "[Composed a music loop: " + song.title + ", " + song.bpm + " BPM, chords " + song.chords.join(" ") + "]" });
      stick();
    });
  }

  function drawWave(c, buf, progress, peaks) {
    var dpr = window.devicePixelRatio || 1, w = c.clientWidth || 300, h = c.clientHeight || 72;
    if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    var g = c.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    var bars = Math.floor(w / 3);
    if (!peaks || peaks.length !== bars) {
      peaks = [];
      var d = buf.getChannelData(0), step = Math.floor(d.length / bars);
      for (var i = 0; i < bars; i++) { var m = 0; for (var j = i * step; j < (i + 1) * step; j += 16) m = Math.max(m, Math.abs(d[j])); peaks.push(m); }
    }
    g.clearRect(0, 0, w, h);
    for (var k = 0; k < bars; k++) {
      var bh = Math.max(2, peaks[k] * (h - 6));
      g.fillStyle = k / bars < progress ? "#e5352b" : "#3a3a38";
      g.fillRect(k * 3, (h - bh) / 2, 2, bh);
    }
    return peaks;
  }

  // Video ---------------------------------------------------------------
  function videoFlow(brief, act) {
    var bot = addBot();
    var vertical = (aspSel.value === "9:16") || (aspSel.value === "auto" && act && act.aspect === "9:16");
    var aspect = vertical ? "9:16" : "16:9";
    var card = el("div", "card" + (vertical ? " tall" : ""));
    var body = el("div", "card-body");
    var title = el("p", "card-title", "Planning the shots…");
    var steps = el("ul", "steps", "<li class=\"on\">Writing a 4-shot plan</li><li>Drawing the shots</li><li>Composing the soundtrack</li><li>Animating and recording</li>");
    var shots = el("div", "shots");
    for (var i = 0; i < 4; i++) shots.appendChild(el("div", "shot", "<span>" + (i + 1) + "</span>"));
    body.appendChild(title); body.appendChild(steps); body.appendChild(shots);
    card.appendChild(body);
    bot.body.remove();
    bot.msg.appendChild(card);
    stick();
    var li = steps.children;
    function step(n) { for (var k = 0; k < li.length; k++) li[k].className = k < n ? "done" : k === n ? "on" : ""; }
    var plan;
    return chatJSON(SYS_VIDEO, brief, 1400).then(function (p) {
      if (p.refuse) throw new Error(p.refuse);
      var sc = Array.isArray(p.scenes) ? p.scenes.filter(function (s) { return s && s.prompt; }).slice(0, 4) : [];
      if (sc.length < 2) throw new Error("The plan came back incomplete. Please try again.");
      plan = { title: String(p.title || "Untitled").slice(0, 60), look: String(p.look || "cinematic, soft light").slice(0, 200), scenes: sc, music: String(p.music || brief) };
      title.textContent = plan.title;
      step(1);
      var songP = composeSong(plan.music + ", soundtrack for a short video").then(function (s) { return s; });
      var frames = [];
      var seq = plan.scenes.reduce(function (pr, s, idx) {
        return pr.then(function () {
          var box = shots.children[idx];
          box.classList.add("busy");
          return genImage(s.prompt + ". " + plan.look + ". Cinematic still, no text, no watermark.", aspect).then(function (img) {
            box.classList.remove("busy");
            var im = new Image(); im.src = img.url; im.alt = s.caption || ""; box.appendChild(im);
            frames[idx] = img;
          });
        });
      }, Promise.resolve());
      return seq.then(function () { step(2); return songP; }).then(function (song) {
        step(3);
        var seconds = 2 + plan.scenes.length * 5.2 + 1.8;
        return renderSong(song, seconds).then(function (buf) {
          return Promise.all(frames.map(function (f) { return createImageBitmap(f.blob); })).then(function (bitmaps) {
            var prog = el("div", "prog", "<i></i>");
            body.appendChild(prog);
            var media = el("div", "card-media");
            media.style.aspectRatio = vertical ? "9 / 16" : "16 / 9";
            card.insertBefore(media, body);
            return recordVideo({ bitmaps: bitmaps, scenes: plan.scenes, title: plan.title, audio: buf, vertical: vertical, seconds: seconds, preview: media },
              function (p) { prog.firstChild.style.width = Math.round(p * 100) + "%"; })
              .then(function (out) {
                step(4);
                prog.remove(); steps.remove(); shots.remove();
                media.innerHTML = "";
                var v = document.createElement("video");
                v.src = out.url; v.controls = true; v.playsInline = true;
                media.appendChild(v);
                body.appendChild(el("p", "card-meta", esc(plan.scenes.map(function (s) { return s.caption; }).filter(Boolean).join(" · ")) + "<br>Music: " + esc(song.title) + ", " + song.bpm + " BPM"));
                var acts = el("div", "card-acts");
                var dl = el("button", "primary", ICON.download + "Download " + out.ext.toUpperCase());
                dl.type = "button";
                dl.onclick = function () { saveAs(out.url, "cepheus-" + slug(plan.title) + "." + out.ext); };
                acts.appendChild(dl);
                body.appendChild(acts);
                history.push({ role: "assistant", content: "[Made a video: " + plan.title + "]" });
                stick();
              });
          });
        });
      });
    }).catch(function (e) {
      card.remove();
      errorCard(bot.msg, e.message, function () { bot.msg.remove(); setBusy(true); videoFlow(brief, act).then(function () { setBusy(false); }); });
    });
  }

  function recordVideo(o, onProgress) {
    var W = o.vertical ? 720 : 1280, H = o.vertical ? 1280 : 720;
    var c = document.createElement("canvas");
    c.width = W; c.height = H;
    o.preview.appendChild(c);
    var g = c.getContext("2d");
    var INTRO = 2, SHOT = 5.2, FADE = 0.8, total = o.seconds;
    var types = ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
    var mime = window.MediaRecorder ? types.find(function (t) { return MediaRecorder.isTypeSupported(t); }) : null;
    if (!mime || !c.captureStream) return Promise.reject(new Error("This browser cannot record video. Try Chrome, Edge or Firefox on a computer."));
    return document.fonts.load("600 40px Geist").catch(function () {}).then(function () {
      return new Promise(function (resolve, reject) {
        var AC = window.AudioContext || window.webkitAudioContext;
        var ac = new AC();
        var dest = ac.createMediaStreamDestination();
        var src = ac.createBufferSource();
        src.buffer = o.audio;
        var gain = ac.createGain();
        src.connect(gain); gain.connect(dest);
        var stream = new MediaStream(c.captureStream(30).getVideoTracks().concat(dest.stream.getAudioTracks()));
        var rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6e6, audioBitsPerSecond: 160000 });
        var chunks = [];
        rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
        rec.onerror = function (e) { reject(new Error("Recording failed: " + (e.error && e.error.message || "unknown error"))); };
        rec.onstop = function () {
          ac.close();
          var type = mime.split(";")[0];
          var blob = new Blob(chunks, { type: type });
          resolve({ url: URL.createObjectURL(blob), ext: type === "video/mp4" ? "mp4" : "webm" });
        };
        draw(0);
        ac.resume().then(function () {
          rec.start(250);
          var t0 = ac.currentTime + 0.05;
          gain.gain.setValueAtTime(1, t0 + total - 1.2);
          gain.gain.linearRampToValueAtTime(0, t0 + total);
          src.start(t0);
          (function loop() {
            var t = ac.currentTime - t0;
            draw(Math.max(0, t));
            onProgress(Math.min(1, Math.max(0, t) / total));
            if (t < total) requestAnimationFrame(loop);
            else setTimeout(function () { rec.stop(); }, 120);
          })();
        });
      });
    });

    function cover(img, scale, dx, dy) {
      var r = Math.max(W / img.width, H / img.height) * scale;
      var w = img.width * r, h = img.height * r;
      g.drawImage(img, (W - w) / 2 + dx, (H - h) / 2 + dy, w, h);
    }
    function clamp01(x) { return Math.max(0, Math.min(1, x)); }
    function ease(x) { x = clamp01(x); return x * x * (3 - 2 * x); }
    function wrap(text, maxW) {
      var words = String(text).split(/\s+/), lines = [], cur = "";
      words.forEach(function (w) { var t = cur ? cur + " " + w : w; if (g.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; } else cur = t; });
      if (cur) lines.push(cur);
      return lines.slice(0, 3);
    }
    function draw(t) {
      g.globalAlpha = 1;
      g.fillStyle = "#000"; g.fillRect(0, 0, W, H);
      var n = o.bitmaps.length;
      for (var i = 0; i < n; i++) {
        var s = INTRO + i * SHOT, e = s + SHOT + FADE;
        if (t < s - 0.01 || t > e) continue;
        var p = (t - s) / (SHOT + FADE);
        var a = i === n - 1 ? ease((t - s) / FADE) : ease((t - s) / FADE);
        var zoomIn = i % 2 === 0;
        var scale = zoomIn ? 1.04 + 0.12 * p : 1.16 - 0.12 * p;
        var dir = i % 4 < 2 ? 1 : -1;
        g.globalAlpha = a;
        cover(o.bitmaps[i], scale, dir * (p - 0.5) * W * 0.05, (p - 0.5) * H * 0.02);
        // caption
        var cap = o.scenes[i].caption;
        if (cap) {
          var ca = ease((t - s - 0.5) / 0.5) * (1 - ease((t - (s + SHOT - 0.3)) / 0.4));
          if (ca > 0) {
            g.globalAlpha = ca * 0.85;
            var grad = g.createLinearGradient(0, H * 0.55, 0, H);
            grad.addColorStop(0, "rgba(0,0,0,0)"); grad.addColorStop(1, "rgba(0,0,0,.75)");
            g.fillStyle = grad; g.fillRect(0, H * 0.55, W, H * 0.45);
            g.globalAlpha = ca;
            var fs = Math.round((o.vertical ? W * 0.068 : H * 0.062));
            g.font = "600 " + fs + "px Geist, 'Segoe UI', sans-serif";
            g.textBaseline = "alphabetic";
            var x = Math.round(W * 0.07), lines = wrap(cap, W * 0.82), lh = fs * 1.18;
            var y0 = H - Math.round(H * (o.vertical ? 0.12 : 0.11)) - (lines.length - 1) * lh;
            var rise = (1 - ease((t - s - 0.5) / 0.5)) * 14;
            g.fillStyle = "#e5352b";
            g.fillRect(x, y0 - fs - 14 + rise, Math.round(fs * 0.9), 4);
            g.fillStyle = "#fff";
            lines.forEach(function (l, k) { g.fillText(l, x, y0 + k * lh + rise); });
          }
        }
      }
      // title card
      var ta = 1 - ease((t - INTRO + 0.2) / FADE);
      if (ta > 0) {
        g.globalAlpha = ta;
        g.fillStyle = "#000"; g.fillRect(0, 0, W, H);
        var ts = Math.round(o.vertical ? W * 0.09 : H * 0.085);
        g.font = "500 " + ts + "px Geist, 'Segoe UI', sans-serif";
        g.textAlign = "center";
        g.fillStyle = "#fff";
        var tl = wrap(o.title, W * 0.8);
        var ty = H / 2 - (tl.length - 1) * ts * 0.6 + ease(t / 0.8) * 0 + (1 - ease(t / 0.8)) * 12;
        g.globalAlpha = ta * ease(t / 0.6);
        tl.forEach(function (l, k) { g.fillText(l, W / 2, ty + k * ts * 1.15); });
        g.fillStyle = "#e5352b";
        g.fillRect(W / 2 - 18, ty + (tl.length - 1) * ts * 1.15 + ts * 0.55, 36, 4);
        g.textAlign = "left";
      }
      // end card
      var ea = ease((t - (total - 1.8)) / 0.8);
      if (ea > 0) {
        g.globalAlpha = ea * 0.9;
        g.fillStyle = "#000"; g.fillRect(0, 0, W, H);
        g.globalAlpha = ea;
        g.textAlign = "center";
        g.fillStyle = "#fff";
        var es = Math.round(o.vertical ? W * 0.05 : H * 0.045);
        g.font = "500 " + es + "px Geist, 'Segoe UI', sans-serif";
        g.fillText("Made with Cepheus Studio", W / 2, H / 2);
        g.fillStyle = "#9a9a96";
        g.font = "400 " + Math.round(es * 0.7) + "px 'Geist Mono', Consolas, monospace";
        g.fillText("cepheus.codes", W / 2, H / 2 + es * 1.4);
        g.textAlign = "left";
      }
      g.globalAlpha = 1;
    }
  }

  // ---------------------------------------------------------------- synthesizer
  var NOTE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  function noteToMidi(n) {
    var m = /^([A-Ga-g])([#b]?)(-?\d)$/.exec(String(n).trim());
    if (!m) return null;
    return NOTE[m[1].toUpperCase()] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0) + (parseInt(m[3], 10) + 1) * 12;
  }
  function parseChord(sym) {
    var m = /^([A-G])([#b]?)([^/]*)/.exec(String(sym).trim());
    if (!m) return null;
    var root = NOTE[m[1]] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0);
    var q = m[3], third = 4, fifth = 7, ext = [];
    if (/^(m(?!aj)|min|-)/.test(q)) third = 3;
    if (/dim|°/.test(q)) { third = 3; fifth = 6; }
    if (/aug|\+/.test(q)) fifth = 8;
    if (/sus2/.test(q)) third = 2; else if (/sus/.test(q)) third = 5;
    if (/maj7|maj9|maj13|M7|Δ/.test(q)) ext.push(11);
    else if (/dim7/.test(q)) ext.push(9);
    else if (/7|9|11|13/.test(q)) ext.push(10);
    if (/6/.test(q) && !/13/.test(q)) ext.push(9);
    if (/9|11|13/.test(q)) ext.push(14);
    return { root: root, tones: [0, third, fifth].concat(ext), name: m[0] };
  }
  function sanitizeSong(j) {
    var pick = function (v, list, d) { return list.indexOf(v) >= 0 ? v : d; };
    var chords = (Array.isArray(j.chords) ? j.chords : []).map(parseChord).filter(Boolean).slice(0, 8);
    if (chords.length < 2) chords = ["Am", "F", "C", "G"].map(parseChord);
    var melody = (Array.isArray(j.melody) ? j.melody : []).map(function (n) {
      if (!Array.isArray(n) || n.length < 3) return null;
      var b = +n[0], len = +n[1], midi = noteToMidi(n[2]);
      if (!(b >= 0 && b < 32) || !(len > 0) || midi == null) return null;
      while (midi < 48) midi += 12;
      while (midi > 84) midi -= 12;
      return [b, Math.min(4, Math.max(0.125, len)), midi];
    }).filter(Boolean);
    return {
      title: String(j.title || "Untitled loop").slice(0, 60),
      bpm: Math.max(60, Math.min(160, Math.round(+j.bpm) || 90)),
      chordData: chords,
      chords: chords.map(function (c) { return c.name; }),
      drums: pick(j.drums, ["lofi", "house", "trap", "rock", "ambient", "none"], "lofi"),
      bass: pick(j.bass, ["root", "octave", "walking", "none"], "root"),
      lead: pick(j.lead, ["sine", "square", "saw", "pluck", "bell"], "pluck"),
      pad: j.pad !== false,
      arp: pick(j.arp, ["up", "down", "none"], "none"),
      melody: melody
    };
  }

  var DRUMS = {
    lofi:    { k: "x.....x...x.....", s: "....x.......x...", h: "x.x.x.x.x.x.x.x.", swing: 0.3 },
    house:   { k: "x...x...x...x...", s: "....x.......x...", h: "..x...x...x...x.", o: true },
    trap:    { k: "x......x..x.....", s: "........x.......", h: "xxxxxxxxxxxxxxxx" },
    rock:    { k: "x.....x.x.......", s: "....x.......x...", h: "x.x.x.x.x.x.x.x." },
    ambient: { k: "x...............", s: "................", h: ".......x.......x" }
  };

  function renderSong(song, seconds) {
    var SR = 44100;
    var OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    var ctx = new OAC(2, Math.ceil(SR * seconds), SR);
    var beat = 60 / song.bpm, bar = beat * 4, bars = Math.ceil(seconds / bar);
    var hz = function (m) { return 440 * Math.pow(2, (m - 69) / 12); };

    var master = ctx.createGain(); master.gain.value = 0.9;
    var comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16; comp.ratio.value = 3; comp.attack.value = 0.01; comp.release.value = 0.2;
    master.connect(comp); comp.connect(ctx.destination);
    // fade the tail so loops end cleanly
    master.gain.setValueAtTime(0.9, Math.max(0, seconds - 1.5));
    master.gain.linearRampToValueAtTime(0, seconds);

    var verb = ctx.createConvolver();
    var irLen = SR * 2.4, ir = ctx.createBuffer(2, irLen, SR);
    for (var ch = 0; ch < 2; ch++) { var d = ir.getChannelData(ch); for (var i = 0; i < irLen; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / irLen, 3); }
    verb.buffer = ir;
    var wet = ctx.createGain(); wet.gain.value = 0.22;
    verb.connect(wet); wet.connect(master);

    var noise = ctx.createBuffer(1, SR, SR), nd = noise.getChannelData(0);
    for (var n = 0; n < SR; n++) nd[n] = Math.random() * 2 - 1;

    function env(gainNode, t, a, peak, dec, sus, end, rel) {
      var p = gainNode.gain;
      p.setValueAtTime(0, t);
      p.linearRampToValueAtTime(peak, t + a);
      p.setTargetAtTime(peak * sus, t + a, dec);
      p.setValueAtTime(peak * sus, Math.max(t + a, end));
      p.linearRampToValueAtTime(0, end + rel);
    }
    function osc(type, f, t, stop, detune) { var o = ctx.createOscillator(); o.type = type; o.frequency.value = f; if (detune) o.detune.value = detune; o.start(t); o.stop(stop); return o; }
    function out(node, level, send) { var gn = ctx.createGain(); gn.gain.value = level; node.connect(gn); gn.connect(master); if (send) { var sg = ctx.createGain(); sg.gain.value = send; node.connect(sg); sg.connect(verb); } }

    function pad(t, dur, midis) {
      midis.forEach(function (m) {
        var g = ctx.createGain(), f = ctx.createBiquadFilter();
        f.type = "lowpass"; f.frequency.value = 1100; f.Q.value = 0.4;
        [-8, 8].forEach(function (dt) { osc("sawtooth", hz(m), t, t + dur + 0.8, dt).connect(f); });
        f.connect(g);
        env(g, t, 0.35, 0.05, 0.4, 0.8, t + dur - 0.1, 0.6);
        out(g, 1, 0.9);
      });
    }
    function bassNote(t, dur, m) {
      var g = ctx.createGain(), f = ctx.createBiquadFilter();
      f.type = "lowpass"; f.frequency.value = 420;
      osc("sawtooth", hz(m), t, t + dur + 0.2).connect(f);
      osc("sine", hz(m), t, t + dur + 0.2).connect(g);
      f.connect(g);
      env(g, t, 0.01, 0.22, 0.15, 0.7, t + dur - 0.05, 0.08);
      out(g, 1, 0);
    }
    function lead(t, dur, m, type, vel) {
      var g = ctx.createGain(), f = ctx.createBiquadFilter(), stop = t + dur + 1.6;
      f.type = "lowpass";
      if (type === "bell") {
        [[1, 1], [2.76, 0.35], [5.4, 0.12]].forEach(function (p) { var o = osc("sine", hz(m) * p[0], t, stop); var pg = ctx.createGain(); pg.gain.value = p[1]; o.connect(pg); pg.connect(g); });
        g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.13 * vel, t + 0.005); g.gain.setTargetAtTime(0, t + 0.01, 0.45);
        out(g, 1, 0.6); return;
      }
      if (type === "pluck") {
        osc("sawtooth", hz(m), t, stop).connect(f);
        f.frequency.setValueAtTime(3800, t); f.frequency.setTargetAtTime(500, t, 0.12);
        f.connect(g);
        g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.16 * vel, t + 0.005); g.gain.setTargetAtTime(0, t + 0.01, Math.min(0.35, dur * beat * 0.5 + 0.1));
        out(g, 1, 0.5); return;
      }
      var wave = type === "square" ? "square" : type === "saw" ? "sawtooth" : "sine";
      var o = osc(wave, hz(m), t, stop);
      var vib = osc("sine", 5.2, t, stop), vg = ctx.createGain(); vg.gain.value = wave === "sine" ? 4 : 2; vib.connect(vg); vg.connect(o.detune);
      f.frequency.value = wave === "sine" ? 8000 : 2400;
      o.connect(f); f.connect(g);
      var level = wave === "sine" ? 0.17 : 0.07;
      env(g, t, 0.02, level * vel, 0.2, 0.75, t + dur * beat - 0.02, 0.25);
      out(g, 1, 0.45);
    }
    function kick(t) {
      var o = osc("sine", 150, t, t + 0.5), g = ctx.createGain();
      o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.14);
      g.gain.setValueAtTime(0.9, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.42);
      o.connect(g); out(g, 0.8, 0);
    }
    function snare(t, soft) {
      var s = ctx.createBufferSource(); s.buffer = noise;
      var f = ctx.createBiquadFilter(); f.type = "bandpass"; f.frequency.value = 1800; f.Q.value = 0.7;
      var g = ctx.createGain(); g.gain.setValueAtTime(soft ? 0.18 : 0.38, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
      s.connect(f); f.connect(g); s.start(t); s.stop(t + 0.25);
      var o = osc("triangle", 190, t, t + 0.12), og = ctx.createGain(); og.gain.setValueAtTime(soft ? 0.08 : 0.18, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.1); o.connect(og);
      out(g, 1, 0.25); out(og, 1, 0);
    }
    function hat(t, open, vel) {
      var s = ctx.createBufferSource(); s.buffer = noise;
      var f = ctx.createBiquadFilter(); f.type = "highpass"; f.frequency.value = 7500;
      var g = ctx.createGain(), len = open ? 0.22 : 0.05;
      g.gain.setValueAtTime(0.12 * vel, t); g.gain.exponentialRampToValueAtTime(0.001, t + len);
      s.connect(f); f.connect(g); s.start(t, Math.random() * 0.5); s.stop(t + len + 0.02);
      out(g, 1, 0);
    }

    var cd = song.chordData;
    var pat = DRUMS[song.drums];
    var melodyStart = bars >= 6 ? 2 : 1; // bars
    for (var b = 0; b < bars; b++) {
      var t0 = b * bar;
      var c = cd[b % cd.length];
      var base = 48 + c.root; // C3-based voicing
      if (song.pad) pad(t0, bar, c.tones.slice(0, 4).map(function (x) { return base + 12 + x; }));
      if (song.bass !== "none") {
        var bm = 36 + c.root;
        if (song.bass === "root") { bassNote(t0, beat * 1.8, bm); bassNote(t0 + beat * 2, beat * 1.8, bm); }
        else if (song.bass === "octave") for (var q = 0; q < 8; q++) bassNote(t0 + q * beat / 2, beat * 0.42, bm + (q % 2 ? 12 : 0));
        else { var walk = [0, c.tones[1], c.tones[2], c.tones[1] + 0]; for (var w = 0; w < 4; w++) bassNote(t0 + w * beat, beat * 0.9, bm + walk[w]); }
      }
      if (song.arp !== "none" && b >= 1) {
        var tones = c.tones.slice(0, 4).map(function (x) { return base + 24 + x; });
        if (song.arp === "down") tones.reverse();
        for (var a8 = 0; a8 < 8; a8++) lead(t0 + a8 * beat / 2, 0.4, tones[a8 % tones.length], "pluck", 0.45);
      }
      if (pat && b >= 1) {
        for (var st = 0; st < 16; st++) {
          var tt = t0 + st * beat / 4 + (pat.swing && st % 2 ? pat.swing * beat / 4 : 0);
          if (pat.k[st] === "x") kick(tt);
          if (pat.s[st] === "x") snare(tt, song.drums === "lofi");
          if (pat.h[st] === "x") hat(tt, pat.o && st % 4 === 2, st % 4 === 0 ? 1 : 0.7);
        }
      }
    }
    if (song.melody.length) {
      for (var mb = melodyStart; mb < bars; mb += 8) {
        song.melody.forEach(function (nt) {
          var t = (mb * 4 + nt[0]) * beat;
          if (t < seconds - 0.3) lead(t, nt[1], nt[2], song.lead, 1);
        });
      }
    }
    return ctx.startRendering().then(function (buf) {
      var peak = 0;
      for (var c2 = 0; c2 < buf.numberOfChannels; c2++) { var dd = buf.getChannelData(c2); for (var k = 0; k < dd.length; k += 4) peak = Math.max(peak, Math.abs(dd[k])); }
      if (peak > 0) { var gainN = 0.89 / peak; for (var c3 = 0; c3 < buf.numberOfChannels; c3++) { var d3 = buf.getChannelData(c3); for (var k3 = 0; k3 < d3.length; k3++) d3[k3] *= gainN; } }
      return buf;
    });
  }

  function encodeWAV(buf) {
    var ch = buf.numberOfChannels, len = buf.length, sr = buf.sampleRate;
    var data = new DataView(new ArrayBuffer(44 + len * ch * 2));
    var str = function (o, s) { for (var i = 0; i < s.length; i++) data.setUint8(o + i, s.charCodeAt(i)); };
    str(0, "RIFF"); data.setUint32(4, 36 + len * ch * 2, true); str(8, "WAVE"); str(12, "fmt ");
    data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, ch, true); data.setUint32(24, sr, true);
    data.setUint32(28, sr * ch * 2, true); data.setUint16(32, ch * 2, true); data.setUint16(34, 16, true); str(36, "data"); data.setUint32(40, len * ch * 2, true);
    var chans = []; for (var c = 0; c < ch; c++) chans.push(buf.getChannelData(c));
    var off = 44;
    for (var i = 0; i < len; i++) for (var c4 = 0; c4 < ch; c4++) { var s = Math.max(-1, Math.min(1, chans[c4][i])); data.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true); off += 2; }
    return new Blob([data], { type: "audio/wav" });
  }

  // ---------------------------------------------------------------- controls
  var HINTS = {
    auto: "Auto: chat, or ask for an image, video or song",
    chat: "Chat with Nemotron",
    image: "Describe an image · about 10 seconds",
    video: "Describe a scene · about a minute to make",
    music: "Describe a mood or genre · instrumental"
  };
  var PH = {
    auto: "Ask anything, or describe an image, video or song",
    chat: "Ask anything about code or Cepheus",
    image: "A glass lighthouse at dusk, 35mm film photo",
    video: "A paper boat sailing through a neon city after rain",
    music: "Slow jazzy lo-fi for late-night coding"
  };
  function setMode(m) {
    mode = m;
    root.querySelectorAll(".st-modes button").forEach(function (b) { b.setAttribute("aria-checked", String(b.dataset.mode === m)); });
    aspWrap.hidden = m === "chat" || m === "music";
    aspSel.querySelector('option[value="1:1"]').disabled = m === "video";
    if (m === "video" && aspSel.value === "1:1") aspSel.value = "auto";
    input.placeholder = PH[m];
    hint.textContent = HINTS[m];
  }
  root.querySelectorAll(".st-modes button").forEach(function (b) {
    b.addEventListener("click", function () { setMode(b.dataset.mode); input.focus({ preventScroll: true }); });
  });
  root.addEventListener("click", function (e) {
    var ex = e.target.closest("[data-ex]");
    if (!ex || busy) return;
    setMode(ex.dataset.ex === "chat" ? "auto" : ex.dataset.ex);
    run(ex.dataset.text);
  });
  function grow() { input.style.height = "auto"; input.style.height = Math.min(180, input.scrollHeight) + "px"; send.disabled = busy || !input.value.trim(); }
  input.addEventListener("input", grow);
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
  });
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var t = input.value.trim();
    if (!t || busy) return;
    input.value = "";
    grow();
    run(t);
  });
  setMode("auto");
  grow();
})();
