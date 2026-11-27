// Shared behavior for the Cepheus site: smooth scroll, morphing nav, silk ribbons, live illustrations.
(function () {
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---------- Ultra-smooth scrolling (Lenis); native scrolling when motion is reduced ----------
  var lenis = null;
  if (!reduce && window.Lenis) {
    lenis = new window.Lenis({ duration: 1.25, easing: function (t) { return Math.min(1, 1.001 - Math.pow(2, -10 * t)); }, smoothWheel: true, wheelMultiplier: 0.9, touchMultiplier: 1.4 });
    var raf = function (t) { lenis.raf(t); requestAnimationFrame(raf); };
    requestAnimationFrame(raf);
  }
  // In-page links glide to their section, leaving room for the floating nav.
  document.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest('a[href^="#"]');
    if (!a) return;
    var id = a.getAttribute("href");
    var el = id.length > 1 && document.querySelector(id);
    if (!el) return;
    e.preventDefault();
    if (lenis) lenis.scrollTo(el, { offset: -84, duration: 1.6 });
    else el.scrollIntoView({ behavior: reduce ? "auto" : "smooth" });
    history.replaceState(null, "", id);
  });

  // ---------- Nav morphs from a full-width bar into a floating pill ----------
  var nav = document.getElementById("nav");
  var onScroll = function () {
    var y = window.scrollY || document.documentElement.scrollTop;
    if (nav) nav.classList.toggle("scrolled", y > 40);
  };
  if (lenis) lenis.on("scroll", onScroll); else window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  // ---------- Download links from the latest GitHub release ----------
  (function () {
    var dl = document.getElementById("dl");
    var all = document.getElementById("dl-all");
    if (!dl) return;
    var ua = navigator.userAgent;
    var os = /Mac/i.test(ua) ? "mac" : /Linux|X11/i.test(ua) && !/Android/i.test(ua) ? "appimage" : /Win/i.test(ua) ? "win" : "";
    var names = { win: "Windows", mac: "macOS", appimage: "Linux" };
    var label = dl.firstChild;
    if (os) label.nodeValue = "Download for " + names[os] + " ";
    var pick = {
      win: function (n) { return /setup\.exe$/i.test(n) || /\.exe$/i.test(n); },
      mac: function (n) { return /\.dmg$/i.test(n); },
      appimage: function (n) { return /\.AppImage$/i.test(n); },
      deb: function (n) { return /\.deb$/i.test(n); },
      rpm: function (n) { return /\.rpm$/i.test(n); }
    };
    fetch("https://api.github.com/repos/Cepheus-IDE/Cepheus/releases/latest")
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (rel) {
        if (!rel || !rel.assets) return;
        var url = function (k) { var a = rel.assets.filter(function (x) { return pick[k](x.name); })[0]; return a && a.browser_download_url; };
        if (os && url(os)) dl.href = url(os);
        if (all) Array.prototype.forEach.call(all.querySelectorAll("a[data-os]"), function (a) { var u = url(a.dataset.os); if (u) a.href = u; });
        var v = document.getElementById("dl-ver"); if (v && rel.tag_name) v.textContent = "Version " + rel.tag_name.replace(/^v/, "");
      })
      .catch(function () {});
  })();

  // ---------- Silk ribbons drawn on canvas ----------
  var silks = Array.prototype.slice.call(document.querySelectorAll("canvas.silk")).map(function (canvas) {
    var host = canvas.parentElement;
    var variant = canvas.dataset.variant || "hero";
    var ctx = canvas.getContext("2d");
    var s = { canvas: canvas, host: host, ctx: ctx, W: 0, H: 0, visible: true, variant: variant };
    // Centerline from bottom-left to top-right; the final ribbon sweeps the other way.
    s.center = function (u) {
      var flip = variant === "final";
      var x = -0.06 + u * 1.12;
      var y = 0.96 - 0.8 * Math.pow(u, 1.2) + 0.07 * Math.sin(u * Math.PI * 1.6);
      if (flip) y = 0.1 + 0.75 * Math.pow(u, 1.1) - 0.06 * Math.sin(u * Math.PI * 1.4);
      if (variant === "page") y = 0.85 - 0.6 * u + 0.08 * Math.sin(u * Math.PI * 2);
      return [x * s.W, y * s.H];
    };
    s.width = function (u) { return s.H * (variant === "page" ? 0.06 + 0.16 * Math.sin(Math.PI * u) : 0.07 + 0.2 * Math.sin(Math.PI * Math.min(1, u * 1.05))); };
    s.resize = function () {
      var r = host.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
      s.W = r.width; s.H = r.height;
      canvas.width = Math.round(s.W * dpr); canvas.height = Math.round(s.H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    s.draw = function (phase) {
      var W = s.W, H = s.H;
      ctx.clearRect(0, 0, W, H);
      var strands = W < 700 ? 48 : 92, steps = 100;
      for (var k0 = 0; k0 < strands; k0++) {
        var k = k0 / (strands - 1) - 0.5;
        ctx.beginPath();
        for (var i = 0; i <= steps; i++) {
          var u = i / steps, c = s.center(u), c2 = s.center(Math.min(1, u + 0.01));
          var nx = -(c2[1] - c[1]), ny = c2[0] - c[0], len = Math.hypot(nx, ny) || 1;
          nx /= len; ny /= len;
          var twist = Math.cos(u * 5.2 + phase + k * 0.9);
          var off = k * s.width(u) * (0.35 + 0.65 * twist);
          var x = c[0] + nx * off, y = c[1] + ny * off;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        var edge = 1 - Math.abs(k) * 2;
        ctx.strokeStyle = "rgba(118,118,116," + (0.045 + 0.1 * edge * edge).toFixed(3) + ")";
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      ctx.beginPath();
      for (var j = 0; j <= 140; j++) {
        var v = j / 140, p = s.center(v);
        var yy = p[1] + s.width(v) * 0.9 * Math.sin(v * 3.4 + phase * 0.6) + H * 0.04;
        if (j === 0) ctx.moveTo(p[0], yy); else ctx.lineTo(p[0], yy);
      }
      ctx.strokeStyle = "rgba(118,118,116,.2)";
      ctx.stroke();
    };
    return s;
  });

  var chips = Array.prototype.slice.call(document.querySelectorAll(".hero .chip"));
  function placeChips() {
    var s = silks.find(function (x) { return x.variant === "hero"; });
    if (!s) return;
    chips.forEach(function (el, n) {
      var u = parseFloat(el.dataset.x), c = s.center(u);
      var y = c[1] + (n % 2 ? 1 : -1) * s.width(u) * 0.45;
      el.style.left = Math.max(70, Math.min(s.W - 70, c[0])) + "px";
      el.style.top = Math.max(170, Math.min(s.H - 190, y)) + "px";
    });
  }

  function resizeAll() { silks.forEach(function (s) { s.resize(); s.draw(0); }); placeChips(); }
  window.addEventListener("resize", resizeAll);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(resizeAll);
  resizeAll();

  if ("IntersectionObserver" in window) {
    var vis = new IntersectionObserver(function (es) {
      es.forEach(function (e) { silks.forEach(function (s) { if (s.host === e.target) s.visible = e.isIntersecting; }); });
    });
    silks.forEach(function (s) { vis.observe(s.host); });
  }
  if (!reduce) {
    var last = 0;
    var tick = function (t) {
      if (t - last > 33) {
        last = t;
        // Scroll nudges the folds so the ribbon feels connected to the page.
        var phase = t / 4200 + (window.scrollY || 0) / 900;
        silks.forEach(function (s) { if (s.visible) s.draw(phase); });
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // ---------- Hero prompt: a short, labelled example run ----------
  var form = document.getElementById("ask"), input = document.getElementById("ask-input"), reply = document.getElementById("reply");
  if (form) {
    var examples = ["Add a dark mode toggle to my settings page…", "Write tests for src/cart.ts and make them pass…", "Find why the login button does nothing…", "Explain how this project is structured…"];
    var ex = 0;
    if (!reduce) setInterval(function () {
      if (document.activeElement === input || input.value) return;
      ex = (ex + 1) % examples.length; input.placeholder = examples[ex];
    }, 3200);
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var task = (input.value || input.placeholder).replace(/…$/, "").trim().replace(/[<>&"]/g, "");
      var lines = ["<b>plan</b>  read the relevant files, then make the change", "<b>edit</b>  2 files changed", "<b>check</b> <span class=\"ok\">✓ tests pass</span>", "Example only. Download Cepheus to run “" + task + "” on your own project."];
      reply.innerHTML = "";
      lines.forEach(function (l, i) { setTimeout(function () { var d = document.createElement("div"); d.innerHTML = l; reply.appendChild(d); }, reduce ? 0 : 420 * i); });
    });
  }

  // ---------- Seamless marquees: duplicate the track once ----------
  document.querySelectorAll("[data-marquee] .marquee-track").forEach(function (track) {
    var items = Array.prototype.slice.call(track.children);
    items.forEach(function (n) { var c = n.cloneNode(true); c.setAttribute("aria-hidden", "true"); track.appendChild(c); });
  });

  // ---------- Animated demo window: loops while on screen ----------
  var demo = document.getElementById("demoWin");
  if (demo && !reduce) {
    demo.classList.add("has-js");
    var rows = demo.querySelectorAll(".step-row");
    var timers = [], running = false;
    var reset = function () {
      demo.classList.remove("code-new", "term-on", "answered");
      rows.forEach(function (r) { r.classList.remove("show", "done"); });
    };
    var at = function (ms, fn) { timers.push(setTimeout(fn, ms)); };
    var cycle = function () {
      reset();
      at(600, function () { rows[0].classList.add("show"); });
      at(1700, function () { rows[0].classList.add("done"); rows[1].classList.add("show"); });
      at(2600, function () { demo.classList.add("code-new"); });
      at(3400, function () { rows[1].classList.add("done"); rows[2].classList.add("show"); });
      at(4600, function () { demo.classList.add("term-on"); rows[2].classList.add("done"); });
      at(5400, function () { demo.classList.add("answered"); });
      at(10500, cycle);
    };
    var start = function () { if (running) return; running = true; cycle(); };
    var stop = function () { running = false; timers.forEach(clearTimeout); timers = []; };
    if ("IntersectionObserver" in window) {
      new IntersectionObserver(function (es) { es.forEach(function (e) { e.isIntersecting ? start() : stop(); }); }, { threshold: 0.35 }).observe(demo);
    } else start();
  }

  // ---------- Count-up numbers and the build terminal, once each ----------
  var once = function (el, fn) {
    if (!("IntersectionObserver" in window) || reduce) return;
    var io = new IntersectionObserver(function (es) { es.forEach(function (e) { if (e.isIntersecting) { io.disconnect(); fn(); } }); }, { threshold: 0.5 });
    io.observe(el);
  };
  document.querySelectorAll("[data-count]").forEach(function (el) {
    var to = parseFloat(el.dataset.count);
    if (!to) return;
    once(el, function () {
      var t0 = performance.now(), dur = 1400;
      var step = function (t) {
        var p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 3);
        el.textContent = Math.round(to * e);
        if (p < 1) requestAnimationFrame(step);
      };
      el.textContent = "0"; requestAnimationFrame(step);
    });
  });
  var term = document.getElementById("term");
  if (term) once(term, function () {
    term.classList.add("typing");
    Array.prototype.forEach.call(term.children, function (line, i) { setTimeout(function () { line.classList.add("on"); }, 350 + i * 650); });
  });

  // ---------- Docs: highlight the section in view ----------
  var tocLinks = Array.prototype.slice.call(document.querySelectorAll(".toc a"));
  if (tocLinks.length && "IntersectionObserver" in window) {
    var tio = new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        if (e.isIntersecting) tocLinks.forEach(function (a) { a.classList.toggle("on", a.getAttribute("href") === "#" + e.target.id); });
      });
    }, { rootMargin: "-25% 0px -65% 0px" });
    document.querySelectorAll(".doc section").forEach(function (s) { tio.observe(s); });
  }

  // ---------- Copy buttons ----------
  document.querySelectorAll("[data-copy]").forEach(function (b) {
    b.addEventListener("click", function () {
      var text = b.getAttribute("data-copy");
      var done = function () { var t = b.textContent; b.textContent = "Copied"; setTimeout(function () { b.textContent = t; }, 1600); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { selectText(b); });
      else selectText(b);
    });
  });
  function selectText(b) {
    var code = b.parentElement && b.parentElement.querySelector("code");
    if (!code) return;
    var r = document.createRange(); r.selectNodeContents(code);
    var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
  }
})();
