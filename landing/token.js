// $CEPHEUS on the site: token band (CA + X), the Connect wallet menu and the Top holders table.
// Read-only: the wallet is only asked for accounts and to switch network. No signatures, no transactions.
(function () {
  // Robinhood Chain mainnet, verified 2026-11-27 against
  // https://docs.robinhood.com/chain/add-network-to-wallet and https://docs.robinhood.com/chain/connecting
  // (chain ID 4663 = 0x1237, the public RPC answered eth_chainId 0x1237; explorer is Blockscout).
  var CHAIN = {
    chainId: "0x1237",
    chainName: "Robinhood Chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://rpc.mainnet.chain.robinhood.com"],
    blockExplorerUrls: ["https://robinhoodchain.blockscout.com"]
  };
  var TICKER = "$CEPHEUS";
  var STORE_KEY = "cepheus.wallet";

  var X_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z"/></svg>';

  var esc = function (s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var short = function (a) { return a ? a.slice(0, 6) + "…" + a.slice(-4) : ""; };
  var store = {
    get: function () { try { return localStorage.getItem(STORE_KEY); } catch (e) { return null; } },
    set: function (v) { try { if (v) localStorage.setItem(STORE_KEY, v); else localStorage.removeItem(STORE_KEY); } catch (e) {} }
  };
  function copyText(btn, text) {
    var done = function () { var t = btn.textContent; btn.textContent = "Copied"; setTimeout(function () { btn.textContent = t; }, 1600); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () {});
    else {
      var ta = document.createElement("textarea"); ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select(); try { document.execCommand("copy"); done(); } catch (e) {} ta.remove();
    }
  }

  // ---------- Public token data ----------
  var site = { ca: null, x: null };
  var ready = fetch("/api/site/public", { cache: "no-store" })
    .then(function (r) { return r.ok ? r.json() : {}; })
    .catch(function () { return {}; })
    .then(function (d) {
      site.ca = typeof d.ca === "string" && /^0x[0-9a-fA-F]{40}$/.test(d.ca) ? d.ca : null;
      site.x = typeof d.x === "string" && /^https:\/\/x\.com\/[A-Za-z0-9_]{1,15}$/.test(d.x) ? d.x : null;
      return site;
    });

  // Fills every [data-token] block; the block stays hidden while there is nothing to show.
  function render(root, data) {
    var has = !!(data.ca || data.x);
    root.hidden = !has;
    var caWrap = root.querySelector("[data-ca-wrap]"), caEl = root.querySelector("[data-ca]");
    var xEl = root.querySelector("[data-x]"), hl = root.querySelector("[data-holders-link]");
    if (caWrap) caWrap.hidden = !data.ca;
    if (caEl) { caEl.textContent = data.ca || ""; caEl.title = data.ca || ""; }
    if (xEl) {
      xEl.hidden = !data.x;
      if (data.x) { xEl.href = data.x; xEl.setAttribute("aria-label", "$CEPHEUS on X (@" + data.x.split("/").pop() + ")"); }
      if (!xEl.querySelector("svg")) xEl.insertAdjacentHTML("afterbegin", X_ICON);
    }
    if (hl) hl.hidden = !data.ca;
    var copy = root.querySelector("[data-copy-ca]");
    if (copy && !copy._bound) { copy._bound = true; copy.addEventListener("click", function () { var c = root.querySelector("[data-ca]"); if (c && c.textContent) copyText(copy, c.textContent); }); }
  }
  window.CepheusToken = { render: render, ready: ready, chain: CHAIN };

  ready.then(function (d) {
    document.querySelectorAll("[data-token]:not([data-preview])").forEach(function (el) { render(el, d); });
    document.querySelectorAll("[data-token-link]").forEach(function (a) { a.hidden = !(d.ca || d.x); });
    if (walletEl) { wallet.refreshBalance(); }
    if (hold) hold.start(d);
  });

  // ---------- Wallet ----------
  var walletEl = document.getElementById("wallet");
  var wallet = { address: null, chainId: null, provider: null, info: null, balance: null, balanceState: "idle", msg: null, busy: false, refreshBalance: function () {} };
  window.CepheusWallet = wallet;

  if (walletEl) (function () {
    var btn = walletEl.querySelector(".wallet-btn"), label = walletEl.querySelector(".w-label"), menu = walletEl.querySelector(".w-menu");
    var found = [];
    window.addEventListener("eip6963:announceProvider", function (e) {
      var d = e.detail;
      if (!d || !d.info || !d.provider || found.some(function (w) { return w.info.uuid === d.info.uuid; })) return;
      found.push(d);
      if (walletEl.classList.contains("open") && !wallet.address) draw();
    });
    window.dispatchEvent(new Event("eip6963:requestProvider"));

    function list() {
      if (found.length) return found;
      var eth = window.ethereum;
      if (!eth) return [];
      var name = eth.isRabby ? "Rabby" : eth.isMetaMask ? "MetaMask" : eth.isCoinbaseWallet ? "Coinbase Wallet" : "Browser wallet";
      return [{ info: { uuid: "injected", name: name, icon: "", rdns: "injected" }, provider: eth }];
    }
    function idOf(w) { return w.info.rdns || w.info.name; }
    function icon(info) {
      if (info.icon && /^data:image\/(svg\+xml|png|jpeg|webp|gif)[;,]/i.test(info.icon)) return '<img alt="" src="' + esc(info.icon) + '">';
      return '<span class="w-ph">' + esc((info.name || "W").charAt(0).toUpperCase()) + "</span>";
    }

    function setOpen(open) {
      walletEl.classList.toggle("open", open);
      btn.setAttribute("aria-expanded", open ? "true" : "false");
      if (open) { draw(); var n = document.getElementById("nav"); if (n) { n.classList.remove("menu-open"); var mb = n.querySelector(".nav-menu-btn"); if (mb) mb.setAttribute("aria-expanded", "false"); } }
    }
    btn.addEventListener("click", function (e) { e.stopPropagation(); setOpen(!walletEl.classList.contains("open")); });
    document.addEventListener("click", function (e) { if (!walletEl.contains(e.target)) setOpen(false); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && walletEl.classList.contains("open")) { setOpen(false); btn.focus(); } });

    function paintButton() {
      walletEl.classList.toggle("on", !!wallet.address);
      walletEl.classList.toggle("wrong", !!wallet.address && !onChain());
      walletEl.classList.toggle("busy", wallet.busy);
      label.innerHTML = wallet.address ? esc(short(wallet.address)) : 'Connect<span class="w-long"> wallet</span>';
      btn.setAttribute("aria-label", wallet.address ? "Wallet " + wallet.address : "Connect wallet");
      btn.title = wallet.address || "Connect wallet";
    }
    function onChain() { return String(wallet.chainId || "").toLowerCase() === CHAIN.chainId; }

    function draw() {
      var h = "";
      if (!wallet.address) {
        var ws = list();
        h += '<div class="w-head"><span>Connect a wallet</span><b>' + esc(CHAIN.chainName) + "</b></div>";
        if (wallet.msg) h += '<div class="w-msg" role="alert">' + esc(wallet.msg) + "</div>";
        if (ws.length) ws.forEach(function (w, i) {
          h += '<button type="button" class="w-item" role="menuitem" data-i="' + i + '">' + icon(w.info) + "<span>" + esc(w.info.name) + "</span>" + (store.get() === idOf(w) ? "<small>Last used</small>" : "") + "</button>";
        });
        else h += '<div class="w-msg">No wallet found in this browser. Install <a href="https://metamask.io/download/" target="_blank" rel="noopener">MetaMask</a> or <a href="https://rabby.io/" target="_blank" rel="noopener">Rabby</a>, then reload this page.</div>';
        h += '<div class="w-note">Read-only: Cepheus only reads your address and balance. It never asks you to sign or send anything.</div>';
      } else {
        h += '<div class="w-acct"><div class="w-line"><b>' + esc(short(wallet.address)) + '</b><button type="button" class="copy" data-act="copy">Copy</button></div>';
        if (site.ca) {
          var v = !onChain() ? "–" : wallet.balanceState === "loading" ? "…" : wallet.balanceState === "error" ? "Unavailable" : wallet.balance == null ? "–" : wallet.balance;
          h += '<div class="w-bal">' + esc(v) + "<small>" + TICKER + "</small></div>";
        }
        h += "</div>";
        if (wallet.msg) h += '<div class="w-msg" role="alert">' + esc(wallet.msg) + "</div>";
        if (!onChain()) h += '<button type="button" class="w-item" role="menuitem" data-act="switch"><span class="w-ph">⇄</span><span>Switch to ' + esc(CHAIN.chainName) + "</span></button>";
        h += '<a class="w-item" role="menuitem" target="_blank" rel="noopener" href="' + esc(CHAIN.blockExplorerUrls[0] + "/address/" + wallet.address) + '"><span class="w-ph">↗</span><span>View on explorer</span></a>';
        if (site.ca && !document.getElementById("holders")) h +='<a class="w-item" role="menuitem" href="holders.html"><span class="w-ph">#</span><span>Top holders</span></a>';
        h += '<button type="button" class="w-item danger" role="menuitem" data-act="disconnect"><span class="w-ph">×</span><span>Disconnect</span></button>';
      }
      menu.innerHTML = h;
    }
    menu.addEventListener("click", function (e) {
      e.stopPropagation();
      var t = e.target.closest("button[data-i], button[data-act]");
      if (!t) return;
      if (t.dataset.i != null) return connect(list()[+t.dataset.i], true);
      var act = t.dataset.act;
      if (act === "copy") copyText(t, wallet.address);
      if (act === "switch") switchChain().then(loadBalance, fail);
      if (act === "disconnect") disconnect();
    });

    function fail(e) {
      var code = e && (e.code || (e.data && e.data.originalError && e.data.originalError.code));
      wallet.msg = code === 4001 ? "Request was rejected in the wallet." : code === -32002 ? "Your wallet already has a pending request. Open it to continue." : (e && e.message ? String(e.message).slice(0, 140) : "Something went wrong.");
      wallet.busy = false; paintButton(); if (walletEl.classList.contains("open")) draw();
    }

    var listening = null;
    function onAccounts(a) { if (!a || !a.length) return disconnect(true); wallet.address = a[0]; changed(); loadBalance(); }
    function onChainChanged(c) { wallet.chainId = c; changed(); loadBalance(); }
    function bind(p) {
      unbind();
      if (p && p.on) { p.on("accountsChanged", onAccounts); p.on("chainChanged", onChainChanged); listening = p; }
    }
    function unbind() {
      if (listening && listening.removeListener) { listening.removeListener("accountsChanged", onAccounts); listening.removeListener("chainChanged", onChainChanged); }
      listening = null;
    }
    function changed() {
      paintButton();
      if (walletEl.classList.contains("open")) draw();
      document.dispatchEvent(new CustomEvent("cepheus:wallet", { detail: { address: wallet.address } }));
    }

    function switchChain() {
      var p = wallet.provider;
      return p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN.chainId }] }).catch(function (e) {
        var code = e && (e.code || (e.data && e.data.originalError && e.data.originalError.code));
        if (code === 4902 || /unrecognized chain|not been added|unknown chain/i.test((e && e.message) || "")) {
          return p.request({ method: "wallet_addEthereumChain", params: [CHAIN] });
        }
        throw e;
      }).then(function () { return p.request({ method: "eth_chainId" }); }).then(function (c) { wallet.chainId = c; wallet.msg = null; changed(); });
    }

    function call(data) {
      return wallet.provider.request({ method: "eth_call", params: [{ to: site.ca, data: data }, "latest"] });
    }
    function format(raw, dec) {
      var base = BigInt(10) ** BigInt(dec), whole = raw / base, frac = dec ? (raw % base).toString().padStart(dec, "0").slice(0, 4).replace(/0+$/, "") : "";
      return whole.toLocaleString("en-US") + (frac ? "." + frac : "");
    }
    var seq = 0;
    function loadBalance() {
      var my = ++seq;
      if (!wallet.address || !site.ca || !onChain()) { wallet.balance = null; wallet.balanceState = "idle"; if (walletEl.classList.contains("open")) draw(); return Promise.resolve(); }
      wallet.balanceState = "loading"; if (walletEl.classList.contains("open")) draw();
      var addr = wallet.address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
      return Promise.all([call("0x70a08231" + addr), call("0x313ce567")]).then(function (r) {
        if (my !== seq) return;
        var raw = BigInt(r[0] && r[0] !== "0x" ? r[0] : "0x0"), dec = Number(BigInt(r[1] && r[1] !== "0x" ? r[1] : "0x12"));
        wallet.balance = format(raw, Math.min(dec, 36)); wallet.balanceState = "ok";
      }).catch(function () { if (my === seq) wallet.balanceState = "error"; }).then(function () { if (my === seq && walletEl.classList.contains("open")) draw(); });
    }
    wallet.refreshBalance = loadBalance;

    function connect(w, interactive) {
      if (!w) return;
      wallet.msg = null; wallet.busy = true; paintButton(); draw();
      var p = w.provider;
      return p.request({ method: interactive ? "eth_requestAccounts" : "eth_accounts" }).then(function (accts) {
        if (!accts || !accts.length) { wallet.busy = false; paintButton(); return; }
        wallet.provider = p; wallet.info = w.info; wallet.address = accts[0];
        store.set(idOf(w)); bind(p);
        return p.request({ method: "eth_chainId" }).then(function (c) {
          wallet.chainId = c;
          // Ask to switch only when the visitor clicked; a silent restore never opens a wallet prompt.
          if (interactive && !onChain()) return switchChain().catch(function (e) { fail(e); wallet.msg = "Connected, but your wallet is on another network."; });
        }).then(function () { wallet.busy = false; changed(); return ready.then(loadBalance); });
      }).catch(fail);
    }

    function disconnect(fromWallet) {
      var p = wallet.provider;
      unbind();
      if (p && !fromWallet) p.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] }).catch(function () {});
      store.set(null);
      wallet.address = wallet.provider = wallet.info = wallet.chainId = wallet.balance = null; wallet.msg = null; wallet.busy = false; wallet.balanceState = "idle";
      changed();
    }

    paintButton();
    // Reconnect silently to the wallet used last time (announcements arrive within a moment).
    var last = store.get();
    if (last) setTimeout(function () {
      var w = list().filter(function (x) { return idOf(x) === last; })[0];
      if (w) connect(w, false);
    }, 350);
  })();

  // ---------- Top holders page ----------
  var holdEl = document.getElementById("holders");
  var hold = holdEl && (function () {
    var body = holdEl.querySelector("tbody"), state = document.getElementById("hold-state"), meta = document.getElementById("hold-meta");
    var timer = null, last = null;
    function skeleton() {
      var h = "";
      for (var i = 0; i < 8; i++) h += '<tr class="sk" aria-hidden="true"><td><span style="width:20px"></span></td><td><span style="width:' + (50 + (i * 13) % 35) + '%"></span></td><td><span style="width:60%;margin-left:auto"></span></td><td><span style="width:80%"></span></td></tr>';
      body.innerHTML = h;
    }
    function showState(title, text, retry) {
      holdEl.hidden = true; state.hidden = false;
      state.innerHTML = "<h3>" + esc(title) + "</h3><p>" + esc(text) + "</p>" + (retry ? '<button type="button" class="btn btn-dark" id="hold-retry">Try again</button>' : "");
      var b = document.getElementById("hold-retry"); if (b) b.addEventListener("click", function () { skeleton(); holdEl.hidden = false; state.hidden = true; load(); });
    }
    function pct(p) { return p == null ? "–" : p > 0 && p < 0.01 ? "<0.01%" : p.toFixed(2) + "%"; }
    function paint(d) {
      last = d;
      var me = (wallet.address || "").toLowerCase();
      if (!d.holders.length) return showState("No holders yet", "Once the token has holders, the largest wallets appear here.");
      holdEl.hidden = false; state.hidden = true;
      body.innerHTML = d.holders.map(function (h) {
        var isMe = me && h.address && h.address.toLowerCase() === me;
        var w = h.percent == null ? 0 : Math.max(0, Math.min(100, h.percent));
        return '<tr' + (isMe ? ' class="me"' : "") + '><td class="rk">' + h.rank + '</td><td class="ad"><a href="' + esc(h.url) + '" target="_blank" rel="noopener" title="' + esc(h.address) + '">' + esc(short(h.address)) + "</a>" +
          (isMe ? '<span class="tg you">You</span>' : h.isContract ? '<span class="tg">Contract</span>' : "") + '</td><td class="bal" title="' + esc(h.balance) + '">' + esc(h.balance) + '</td><td><div class="sh-row"><div class="bar"><i style="width:' + w + '%"></i></div><span>' + esc(pct(h.percent)) + "</span></div></td></tr>";
      }).join("");
      var n = d.token && d.token.holders;
      meta.innerHTML = "<span>Top <b>" + d.holders.length + "</b>" + (n ? " of <b>" + n.toLocaleString("en-US") + "</b> holders" : " holders") + (d.token && d.token.symbol ? " · " + esc(d.token.symbol) : "") + '</span><span class="live">Refreshes every minute</span>';
    }
    function load() {
      return fetch("/api/site/holders?limit=50", { cache: "no-store" })
        .then(function (r) { return r.json().catch(function () { return { status: "unavailable" }; }); })
        .then(function (d) {
          if (d.status === "no_token") { meta.innerHTML = ""; return showState("Token not published yet", "The top holders appear here as soon as the contract address is live."); }
          if (d.status !== "ok" || !Array.isArray(d.holders)) { if (last) return; return showState("Holder data is unavailable", "The block explorer did not answer. This page retries every minute.", true); }
          paint(d);
        })
        .catch(function () { if (!last) showState("Could not load holders", "Check your connection. This page retries every minute.", true); });
    }
    document.addEventListener("cepheus:wallet", function () { if (last) paint(last); });
    return {
      start: function () {
        skeleton(); load();
        timer = setInterval(function () { if (!document.hidden) load(); }, 60000);
        document.addEventListener("visibilitychange", function () { if (!document.hidden && last) load(); });
      }
    };
  })();
})();
