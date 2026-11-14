/* Generated from src/client.jsx */
window.__ModuleLoader__?.load({id:"dsh-conversation-saver",factory(require){
var ConversationSaverModule = (() => {
  var __create = Object.create;
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __getProtoOf = Object.getPrototypeOf;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
    get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
  }) : x)(function(x) {
    if (typeof require !== "undefined") return require.apply(this, arguments);
    throw Error('Dynamic require of "' + x + '" is not supported');
  });
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
    // If the importer is in node compatibility mode or this is not an ESM
    // file that has been converted to a CommonJS file using a Babel-
    // compatible transform (i.e. "__esModule" has not been set), then set
    // "default" to the CommonJS "module.exports" for node compatibility.
    isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
    mod
  ));
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/client.jsx
  var client_exports = {};
  __export(client_exports, {
    default: () => client_default
  });
  var import_react = __toESM(__require("react"), 1);

  // src/style.css
  var style_default = '.dca{--dca-bg:var(--dsw-alias-bg-base,#fff);--dca-card:var(--dsw-alias-bg-layer-2,#f4f6f8);--dca-ink:var(--dsw-alias-label-primary,#18232b);--dca-muted:var(--dsw-alias-label-secondary,#52616c);--dca-line:var(--dsw-alias-border-l2,#d0d8de);--dca-accent:var(--dsw-alias-brand-primary,#155a76);box-sizing:border-box;color:var(--dca-ink);font:14px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}\n.dca *{box-sizing:border-box}.dca button,.dca input{font:inherit}.dca h1,.dca h2,.dca p{margin:0}.dca button{cursor:pointer}.dca button:disabled{opacity:.5;cursor:default}.dca button:focus-visible,.dca input:focus-visible,.dca-header-button:focus-visible{outline:2px solid var(--dca-accent,#155a76);outline-offset:3px}.dca-button,.dca-close{min-height:36px;padding:6px 12px;border:1px solid var(--dca-line);border-radius:8px;background:var(--dca-bg);color:var(--dca-ink);white-space:normal}.dca-primary{background:var(--dca-accent);border-color:var(--dca-accent);color:var(--dsw-alias-bg-base,#fff)}.dca-muted,.dca small{color:var(--dca-muted)}.dca-header-button{display:inline-flex;align-items:center;gap:5px;padding:5px 8px;min-height:32px;border:1px solid var(--dsw-alias-border-l2,#c5d0d8);border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary,#18232b);font:12px/1.4 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;cursor:pointer;white-space:nowrap}\n.dca-panel{height:100%;overflow:auto;background:var(--dca-bg);padding:32px clamp(16px,4vw,56px)}.dca-panel-head{display:flex;justify-content:space-between;align-items:center;gap:24px;max-width:1040px;margin:auto}.dca-panel h1{font-size:28px;letter-spacing:-.02em}.dca-panel-head p{margin-top:6px;color:var(--dca-muted)}.dca-picker{max-width:1040px;margin:32px auto}.dca-toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin:14px 0}.dca-toolbar>strong{margin-right:auto}.dca-search{display:grid;gap:6px;flex:1}.dca input:not([type=checkbox]){display:block;width:100%;min-height:40px;padding:8px 11px;border:1px solid var(--dca-line);border-radius:8px;background:var(--dca-bg);color:var(--dca-ink)}.dca-session-list{list-style:none;margin:24px 0;padding:0;border-top:1px solid var(--dca-line)}.dca-session-list li{border-bottom:1px solid var(--dca-line)}.dca-session-list button{display:flex;align-items:center;gap:18px;width:100%;padding:18px 4px;border:0;text-align:left;background:transparent;color:var(--dca-ink)}.dca-session-list button>span:first-child{flex:1;min-width:0;overflow-wrap:anywhere}.dca-session-list small{flex-shrink:0}\n.dca-dialog{width:min(820px,calc(100vw - 32px));max-height:calc(100dvh - 40px);padding:0;border:1px solid var(--dca-line);border-radius:16px;background:var(--dca-bg);box-shadow:0 18px 90px #0005;overflow:hidden}.dca-dialog[open]{display:flex;flex-direction:column}.dca-dialog::backdrop{background:#10202f70}.dca-dialog-head{display:flex;justify-content:space-between;align-items:start;gap:18px;flex:none;padding:22px 24px 16px;border-bottom:1px solid var(--dca-line)}.dca-dialog-head h2{font-size:21px}.dca-dialog-head p{margin-top:4px;color:var(--dca-muted)}.dca-close{min-width:36px;padding:0;font-size:24px}.dca-preview-body{padding:20px 24px;overflow:auto;min-height:0}.dca-title-field{display:grid;gap:6px;font-weight:550}.dca-title-field input{font-weight:400}.dca-messages{list-style:none;margin:20px 0 0;padding:0;display:grid;gap:16px}.dca-messages li{border:1px solid var(--dca-line);border-radius:10px;overflow:hidden}.dca-message-head{display:flex;align-items:center;gap:8px;background:var(--dca-card);padding:10px 14px;cursor:pointer}.dca-message-head span{margin-left:auto;color:var(--dca-muted);font-size:12px}.dca-message-head input{width:18px;height:18px;accent-color:var(--dca-accent)}.dca-message-text{padding:14px 16px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:320px;overflow:auto;line-height:1.85;user-select:text}.dca-dialog-footer{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:14px 24px;border-top:1px solid var(--dca-line);flex:none}.dca-dialog-footer>.dca-primary{margin-left:auto}.dca-empty{padding:32px 8px;color:var(--dca-muted)}.dca-error,.dca-warning,.dca-success{margin-top:16px!important;padding:14px;border:1px solid var(--dca-line);border-left:3px solid currentColor;border-radius:8px;overflow-wrap:anywhere}.dca-error{color:var(--dsw-alias-state-error-primary,#b42318)}.dca-success p{margin:6px 0 12px}.dca-success{background:var(--dca-card)}\n@media(max-width:600px){.dca-panel-head{align-items:start;flex-direction:column;gap:14px}.dca-panel{padding:20px 16px}.dca-dialog{width:calc(100vw - 16px);max-height:calc(100dvh - 16px);border-radius:12px}.dca-dialog-head,.dca-preview-body,.dca-dialog-footer{padding:16px}.dca-dialog-footer>.dca-muted{display:none}.dca-button,.dca-close,.dca-header-button{min-height:44px}.dca-header-button span{display:none}.dca-header-button{min-width:44px;justify-content:center}.dca-session-list button{gap:10px}.dca-session-list small{max-width:92px}.dca-message-head{min-height:44px}}\n@media(prefers-reduced-motion:reduce){.dca *{scroll-behavior:auto!important;transition:none!important;animation:none!important}}\n@media(forced-colors:active){.dca-primary,.dca-button,.dca-messages li{border:1px solid ButtonText}}\n\n.dca-models{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin:16px 0;color:var(--dca-muted);font-size:12px}.dca-model{display:inline-flex;padding:2px 7px;border:1px solid var(--dca-line);border-radius:6px;line-height:1.5;color:var(--dca-ink);background:var(--dca-card);font-size:12px;overflow-wrap:anywhere}.dca-message-head{flex-wrap:wrap}\n';

  // src/client.jsx
  var API = "/dsh-kb/conversations";
  async function api(path = "", body, signal) {
    const response = await fetch(API + path, { method: body === void 0 ? "GET" : "POST", headers: body === void 0 ? void 0 : { "Content-Type": "application/json" }, body: body === void 0 ? void 0 : JSON.stringify(body), signal });
    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error("\u65E0\u6CD5\u8FDE\u63A5\u77E5\u8BC6\u5E93\uFF0C\u8BF7\u542F\u7528\u77E5\u8BC6\u5E93 0.11.1 \u6216\u66F4\u65B0\u7248\u672C\u3002");
    }
    if (!response.ok || !data.ok) throw new Error(response.status === 404 && data.error?.message !== "\u8FD9\u6BB5\u5BF9\u8BDD\u5DF2\u4E0D\u5B58\u5728\uFF0C\u8BF7\u91CD\u65B0\u9009\u62E9" ? "\u8BF7\u542F\u7528\u77E5\u8BC6\u5E93 0.11.1 \u6216\u66F4\u65B0\u7248\u672C\u540E\u91CD\u8BD5\u3002" : data.error?.message || "\u4FDD\u5B58\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5\u3002");
    return data;
  }
  function Icon({ size = 18 }) {
    return /* @__PURE__ */ import_react.default.createElement("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.6", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" }, /* @__PURE__ */ import_react.default.createElement("path", { d: "M3 3h18v14H9l-5 4v-4H3zM7 8h10M7 12h7" }));
  }
  function open(id) {
    window.dispatchEvent(new CustomEvent("dsh-conversations:preview", { detail: { sessionId: id } }));
  }
  function HeaderAction({ sessionId }) {
    return /* @__PURE__ */ import_react.default.createElement(import_react.default.Fragment, null, /* @__PURE__ */ import_react.default.createElement("style", null, style_default), /* @__PURE__ */ import_react.default.createElement("button", { type: "button", className: "dca-header-button", "aria-label": "\u4FDD\u5B58\u5F53\u524D\u5BF9\u8BDD\u5230\u77E5\u8BC6\u5E93", title: "\u4FDD\u5B58\u5230\u77E5\u8BC6\u5E93 \xB7 AI \u5BF9\u8BDD", onClick: () => open(sessionId) }, /* @__PURE__ */ import_react.default.createElement(Icon, null), /* @__PURE__ */ import_react.default.createElement("span", null, "\u4FDD\u5B58\u5230\u77E5\u8BC6\u5E93")));
  }
  var date = (value) => {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  };
  function Picker({ openKnowledge }) {
    const [sessions, setSessions] = (0, import_react.useState)([]), [next, setNext] = (0, import_react.useState)(null), [loading, setLoading] = (0, import_react.useState)(false), [error, setError] = (0, import_react.useState)(""), [search, setSearch] = (0, import_react.useState)("");
    const active = (0, import_react.useRef)(null);
    async function load(offset = 0) {
      active.current?.abort();
      const controller = new AbortController();
      active.current = controller;
      setLoading(true);
      setError("");
      try {
        const data = await api("/sessions?offset=" + offset, void 0, controller.signal);
        setSessions((old) => offset ? [...old, ...data.sessions] : data.sessions);
        setNext(data.nextOffset);
      } catch (e) {
        if (!controller.signal.aborted) setError(e.message);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    (0, import_react.useEffect)(() => {
      load();
      return () => active.current?.abort();
    }, []);
    const visible = sessions.filter((row) => String(row.title || "").toLowerCase().includes(search.toLowerCase()));
    return /* @__PURE__ */ import_react.default.createElement("section", { className: "dca dca-panel" }, /* @__PURE__ */ import_react.default.createElement("style", null, style_default), /* @__PURE__ */ import_react.default.createElement("header", { className: "dca-panel-head" }, /* @__PURE__ */ import_react.default.createElement("div", null, /* @__PURE__ */ import_react.default.createElement("h1", null, "\u5BF9\u8BDD\u6536\u85CF"), /* @__PURE__ */ import_react.default.createElement("p", null, "\u628A\u503C\u5F97\u7559\u4E0B\u7684\u95EE\u7B54\uFF0C\u653E\u8FDB\u81EA\u5DF1\u7684\u77E5\u8BC6\u5E93\u3002")), /* @__PURE__ */ import_react.default.createElement("button", { className: "dca-button", onClick: openKnowledge }, "\u67E5\u770B\u5DF2\u6536\u85CF\u5BF9\u8BDD")), /* @__PURE__ */ import_react.default.createElement("div", { className: "dca-picker" }, /* @__PURE__ */ import_react.default.createElement("div", { className: "dca-toolbar" }, /* @__PURE__ */ import_react.default.createElement("label", { className: "dca-search" }, "\u641C\u7D22\u5DF2\u52A0\u8F7D\u7684\u5BF9\u8BDD", /* @__PURE__ */ import_react.default.createElement("input", { value: search, onChange: (e) => setSearch(e.target.value), placeholder: "\u8F93\u5165\u5BF9\u8BDD\u6807\u9898" })), /* @__PURE__ */ import_react.default.createElement("button", { className: "dca-button", onClick: () => load(), disabled: loading }, "\u5237\u65B0")), /* @__PURE__ */ import_react.default.createElement("p", { className: "dca-muted" }, "\u4E5F\u53EF\u4EE5\u5728\u4EFB\u610F\u5BF9\u8BDD\u9876\u90E8\uFF0C\u70B9\u51FB\u201C\u4FDD\u5B58\u5230\u77E5\u8BC6\u5E93\u201D\u3002\u4FDD\u5B58\u524D\u53EF\u9009\u62E9\u6574\u6BB5\u6216\u51E0\u6761\u6D88\u606F\u3002"), error && /* @__PURE__ */ import_react.default.createElement("p", { role: "alert", className: "dca-error" }, error), loading && /* @__PURE__ */ import_react.default.createElement("p", { role: "status" }, "\u6B63\u5728\u8BFB\u53D6\u5BF9\u8BDD\u2026"), /* @__PURE__ */ import_react.default.createElement("ul", { className: "dca-session-list" }, visible.map((row) => /* @__PURE__ */ import_react.default.createElement("li", { key: row.id }, /* @__PURE__ */ import_react.default.createElement("button", { onClick: () => open(row.id) }, /* @__PURE__ */ import_react.default.createElement("span", null, row.title), /* @__PURE__ */ import_react.default.createElement("small", null, date(row.createdAt)), /* @__PURE__ */ import_react.default.createElement("span", { "aria-hidden": "true" }, "\u203A"))))), !visible.length && !loading && !error && /* @__PURE__ */ import_react.default.createElement("p", { className: "dca-empty" }, search ? "\u5DF2\u52A0\u8F7D\u7684\u5BF9\u8BDD\u91CC\u6CA1\u6709\u5339\u914D\u6807\u9898\u3002" : "\u8FD8\u6CA1\u6709\u53EF\u6536\u85CF\u7684\u5BF9\u8BDD\u3002"), next !== null && /* @__PURE__ */ import_react.default.createElement("button", { className: "dca-button", disabled: loading, onClick: () => load(next) }, "\u52A0\u8F7D\u66F4\u65E9\u7684\u5BF9\u8BDD")));
  }
  function Preview({ sessionId, onClose, openKnowledge }) {
    const [conversation, setConversation] = (0, import_react.useState)(null), [title, setTitle] = (0, import_react.useState)(""), [selected, setSelected] = (0, import_react.useState)(/* @__PURE__ */ new Set()), [loading, setLoading] = (0, import_react.useState)(true), [saving, setSaving] = (0, import_react.useState)(false), [error, setError] = (0, import_react.useState)(""), [result, setResult] = (0, import_react.useState)(null), [limit, setLimit] = (0, import_react.useState)(40);
    const dialog = (0, import_react.useRef)(null), controller = (0, import_react.useRef)(null), savingRef = (0, import_react.useRef)(false), alive = (0, import_react.useRef)(true);
    async function load() {
      controller.current?.abort();
      const abort = new AbortController();
      controller.current = abort;
      setLoading(true);
      setError("");
      setResult(null);
      try {
        const data = await api("?sessionId=" + encodeURIComponent(sessionId), void 0, abort.signal);
        setConversation(data.conversation);
        setTitle(data.conversation.title);
        setSelected(new Set(data.conversation.messages.map((m) => m.id)));
        setLimit(40);
      } catch (e) {
        if (!abort.signal.aborted) setError(e.message);
      } finally {
        if (!abort.signal.aborted) setLoading(false);
      }
    }
    (0, import_react.useEffect)(() => {
      alive.current = true;
      const previous = document.activeElement;
      dialog.current?.showModal();
      load();
      return () => {
        alive.current = false;
        controller.current?.abort();
        if (previous?.isConnected) previous.focus();
      };
    }, [sessionId]);
    async function save() {
      if (savingRef.current || !conversation) return;
      savingRef.current = true;
      setSaving(true);
      setError("");
      try {
        const saved = await api("", { sessionId, revision: conversation.revision, title, messageIds: [...selected] });
        if (alive.current) {
          setResult(saved);
          window.dispatchEvent(new Event("dsh-kb:conversations"));
        }
      } catch (e) {
        if (alive.current) setError(e.message);
      } finally {
        savingRef.current = false;
        if (alive.current) setSaving(false);
      }
    }
    const messages = conversation?.messages || [];
    function toggle(id) {
      setSelected((old) => {
        const next = new Set(old);
        next.has(id) ? next.delete(id) : next.add(id);
        return next;
      });
      setResult(null);
    }
    return /* @__PURE__ */ import_react.default.createElement("dialog", { ref: dialog, className: "dca dca-dialog", "aria-labelledby": "dca-preview-title", onCancel: (e) => {
      e.preventDefault();
      if (!saving) onClose();
    } }, /* @__PURE__ */ import_react.default.createElement("style", null, style_default), /* @__PURE__ */ import_react.default.createElement("header", { className: "dca-dialog-head" }, /* @__PURE__ */ import_react.default.createElement("div", null, /* @__PURE__ */ import_react.default.createElement("h2", { id: "dca-preview-title" }, "\u4FDD\u5B58\u5230\u77E5\u8BC6\u5E93"), /* @__PURE__ */ import_react.default.createElement("p", null, "\u4FDD\u5B58\u81F3 ", /* @__PURE__ */ import_react.default.createElement("strong", null, "AI \u5BF9\u8BDD"), "\uFF0C\u4FDD\u7559\u539F\u59CB\u53D1\u8A00\u3002")), /* @__PURE__ */ import_react.default.createElement("button", { className: "dca-close", type: "button", "aria-label": "\u5173\u95ED\u4FDD\u5B58\u9884\u89C8", disabled: saving, onClick: onClose }, "\xD7")), /* @__PURE__ */ import_react.default.createElement("div", { className: "dca-preview-body", "aria-busy": loading || saving }, loading ? /* @__PURE__ */ import_react.default.createElement("p", { role: "status", className: "dca-empty" }, "\u6B63\u5728\u8BFB\u53D6\u5B8C\u6574\u5BF9\u8BDD\u2026") : conversation && /* @__PURE__ */ import_react.default.createElement(import_react.default.Fragment, null, /* @__PURE__ */ import_react.default.createElement("label", { className: "dca-title-field" }, "\u6536\u85CF\u6807\u9898", /* @__PURE__ */ import_react.default.createElement("input", { autoFocus: true, value: title, maxLength: 200, disabled: saving || Boolean(result), onChange: (e) => setTitle(e.target.value), "aria-invalid": !title.trim(), "aria-describedby": "dca-save-hint" })), /* @__PURE__ */ import_react.default.createElement("div", { className: "dca-models" }, /* @__PURE__ */ import_react.default.createElement("span", null, "\u4F7F\u7528\u6A21\u578B"), (conversation.models || []).map((model, i) => /* @__PURE__ */ import_react.default.createElement("span", { className: "dca-model", key: i, title: model.provider ? "\u63D0\u4F9B\u65B9\uFF1A" + model.provider : void 0 }, model.model)), messages.some((m) => m.role === "assistant" && !m.model?.model) && /* @__PURE__ */ import_react.default.createElement("span", { className: "dca-model" }, "\u90E8\u5206\u53D1\u8A00\u672A\u8BB0\u5F55\u6A21\u578B")), /* @__PURE__ */ import_react.default.createElement("div", { className: "dca-toolbar" }, /* @__PURE__ */ import_react.default.createElement("strong", null, "\u5DF2\u9009 ", selected.size, " / ", messages.length, " \u6761\u6D88\u606F"), /* @__PURE__ */ import_react.default.createElement("button", { className: "dca-button", disabled: saving || Boolean(result), onClick: () => setSelected(new Set(messages.map((m) => m.id))) }, "\u5168\u9009"), /* @__PURE__ */ import_react.default.createElement("button", { className: "dca-button", disabled: saving || Boolean(result), onClick: () => setSelected(/* @__PURE__ */ new Set()) }, "\u6E05\u7A7A\u9009\u62E9")), /* @__PURE__ */ import_react.default.createElement("p", { className: "dca-muted", id: "dca-save-hint" }, "\u4EC5\u4FDD\u5B58\u4F60\u548C AI \u7684\u53EF\u89C1\u53D1\u8A00\u3002\u5DE5\u5177\u65E5\u5FD7\u548C\u601D\u8003\u8FC7\u7A0B\u4E0D\u5165\u5E93", conversation.attachments ? "\uFF1B\u9644\u4EF6\u4EC5\u4FDD\u7559\u540D\u79F0\uFF0C\u4E0D\u590D\u5236\u6587\u4EF6" : "", "\u3002"), conversation.running && /* @__PURE__ */ import_react.default.createElement("p", { role: "status", className: "dca-warning" }, "AI \u4ECD\u5728\u56DE\u590D\uFF0C\u5B8C\u6210\u540E\u8BF7\u5237\u65B0\u9884\u89C8\u518D\u4FDD\u5B58\u3002"), messages.length === 0 && /* @__PURE__ */ import_react.default.createElement("p", { className: "dca-empty" }, "\u8FD9\u6BB5\u5BF9\u8BDD\u8FD8\u6CA1\u6709\u53EF\u4FDD\u5B58\u7684\u53D1\u8A00\u3002"), /* @__PURE__ */ import_react.default.createElement("ol", { className: "dca-messages" }, messages.slice(0, limit).map((message, index) => /* @__PURE__ */ import_react.default.createElement("li", { key: message.id, "data-role": message.role }, /* @__PURE__ */ import_react.default.createElement("label", { className: "dca-message-head" }, /* @__PURE__ */ import_react.default.createElement("input", { type: "checkbox", checked: selected.has(message.id), disabled: saving || Boolean(result), onChange: () => toggle(message.id), "aria-label": `\u4FDD\u5B58\u7B2C ${index + 1} \u6761${message.role === "user" ? "\u6211\u7684" : "AI"}\u53D1\u8A00` }), /* @__PURE__ */ import_react.default.createElement("strong", null, message.role === "user" ? "\u6211" : "AI"), message.role === "assistant" && /* @__PURE__ */ import_react.default.createElement("small", { className: "dca-model", title: message.model?.provider ? "\u63D0\u4F9B\u65B9\uFF1A" + message.model.provider : void 0 }, message.model?.model || "\u6A21\u578B\u672A\u8BB0\u5F55"), /* @__PURE__ */ import_react.default.createElement("span", null, "\u7B2C ", index + 1, " \u6761")), /* @__PURE__ */ import_react.default.createElement("div", { className: "dca-message-text" }, message.text)))), limit < messages.length && /* @__PURE__ */ import_react.default.createElement("button", { className: "dca-button", onClick: () => setLimit((v) => v + 40) }, "\u7EE7\u7EED\u9884\u89C8\uFF08\u8FD8\u6709 ", messages.length - limit, " \u6761\uFF1B\u5168\u9009\u5305\u542B\u5168\u90E8\u6D88\u606F\uFF09")), error && /* @__PURE__ */ import_react.default.createElement("p", { role: "alert", className: "dca-error" }, error), result && /* @__PURE__ */ import_react.default.createElement("div", { className: "dca-success", role: "status" }, /* @__PURE__ */ import_react.default.createElement("strong", null, result.existed ? "\u8FD9\u4EFD\u5185\u5BB9\u5DF2\u6536\u85CF\uFF0C\u65E0\u9700\u91CD\u590D\u4FDD\u5B58\u3002" : "\u5DF2\u4FDD\u5B58\u5230\u77E5\u8BC6\u5E93 \xB7 AI \u5BF9\u8BDD"), /* @__PURE__ */ import_react.default.createElement("p", null, result.source.title, " \xB7 ", result.source.conversation?.messageCount || selected.size, " \u6761\u6D88\u606F"), /* @__PURE__ */ import_react.default.createElement("button", { className: "dca-button", onClick: () => {
      onClose();
      openKnowledge();
    } }, "\u5728\u77E5\u8BC6\u5E93\u67E5\u770B"))), /* @__PURE__ */ import_react.default.createElement("footer", { className: "dca-dialog-footer" }, /* @__PURE__ */ import_react.default.createElement("button", { className: "dca-button", disabled: loading || saving, onClick: load }, "\u5237\u65B0\u9884\u89C8"), /* @__PURE__ */ import_react.default.createElement("span", { className: "dca-muted" }, "\u624B\u52A8\u4FDD\u5B58 \xB7 \u4E0D\u8C03\u7528\u6A21\u578B"), result ? /* @__PURE__ */ import_react.default.createElement("button", { className: "dca-button dca-primary", onClick: onClose }, "\u5B8C\u6210") : /* @__PURE__ */ import_react.default.createElement("button", { className: "dca-button dca-primary", disabled: loading || saving || !conversation || conversation.running || !selected.size || !title.trim(), onClick: save }, saving ? "\u6B63\u5728\u4FDD\u5B58\u2026" : `\u4FDD\u5B58 ${selected.size} \u6761\u6D88\u606F`)));
  }
  function Overlay({ openKnowledge }) {
    const [sessionId, setSessionId] = (0, import_react.useState)(null);
    (0, import_react.useEffect)(() => {
      const listener = (e) => {
        if (typeof e.detail?.sessionId === "string") setSessionId(e.detail.sessionId);
      };
      window.addEventListener("dsh-conversations:preview", listener);
      return () => window.removeEventListener("dsh-conversations:preview", listener);
    }, []);
    return sessionId ? /* @__PURE__ */ import_react.default.createElement(Preview, { key: sessionId, sessionId, onClose: () => setSessionId(null), openKnowledge }) : null;
  }
  function apply(ctx) {
    const openKnowledge = () => {
      window.dispatchEvent(new Event("dsh-kb:conversations"));
      ctx.layout.selectPanel("kb");
    };
    ctx.effect(() => ctx.locale.register("conversation-saver", { zh: { "panel.label": "\u5BF9\u8BDD\u6536\u85CF" }, en: { "panel.label": "Conversation Saver" } }), "conversation-saver: locale");
    ctx.effect(() => {
      const listener = () => ctx.layout.selectPanel("conversation-saver");
      window.addEventListener("dsh-conversations:open", listener);
      return () => window.removeEventListener("dsh-conversations:open", listener);
    }, "conversation-saver: navigation");
    ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({ name: "conversation.session.header.utilities", id: "conversation-saver", order: 5 }, HeaderAction));
    ctx.slots.inject("shell.overlay", () => ctx.slots.register({ name: "shell.overlay", id: "conversation-saver.preview", inject: () => ({ openKnowledge }) }, Overlay));
    ctx.slots.inject("main", () => ctx.slots.register({ name: "main", key: "conversation-saver", inject: () => ({ openKnowledge }) }, Picker));
    ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({ name: "sidebar.panellist", id: "conversation-saver", order: 23, locale: "conversation-saver", label: () => ctx.locale.bind("conversation-saver")("panel.label") }, Icon));
  }
  var client_default = { name: "conversation-saver", inject: ["slots", "locale", "layout"], apply };
  return __toCommonJS(client_exports);
})();
return ConversationSaverModule.default;}});
