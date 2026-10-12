import { getIconUrl as e, parseIconValue as t, serializeIconValue as n } from "../core.js";
import { n as r, t as i } from "./IconRenderer-86b851bX.js";
import { Suspense as a, lazy as o, memo as s, useCallback as c, useEffect as l, useId as u, useLayoutEffect as d, useMemo as f, useRef as p, useState as m } from "react";
import { Fragment as ee, jsx as h, jsxs as g } from "react/jsx-runtime";
import { createPortal as te } from "react-dom";
//#region src/catalogs.ts
var ne = {
	lucide: "lucide",
	mdi: "mdi",
	ph: "ph",
	si: "simple-icons"
};
function _(e) {
	return Array.isArray(e) ? e.filter((e) => typeof e == "string") : [];
}
function v(e) {
	if (typeof e != "object" || !e) return null;
	let t = e, n = typeof t.categories == "object" && t.categories !== null ? Object.entries(t.categories).flatMap(([e, t]) => {
		let n = _(t);
		return n.length > 0 ? [{
			name: e,
			icons: n
		}] : [];
	}) : [], r = Array.from(/* @__PURE__ */ new Set([..._(t.uncategorized), ...n.flatMap((e) => e.icons)]));
	return r.length > 0 ? {
		icons: r,
		categories: n
	} : null;
}
async function re(e, t) {
	let n = await fetch(`https://api.iconify.design/collection?prefix=${ne[e]}`, { signal: t });
	if (!n.ok) throw Error(`Iconify catalog returned HTTP ${n.status}.`);
	let r = v(await n.json());
	if (!r) throw Error("Iconify catalog returned invalid data.");
	return r;
}
async function ie(e) {
	let t = await fetch("https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons@main/tree.json", { signal: e });
	if (!t.ok) throw Error(`Dashboard Icons returned HTTP ${t.status}.`);
	let n = await t.json();
	if (typeof n != "object" || !n) throw Error("Dashboard Icons returned an invalid catalog.");
	let r = _(n.svg).filter((e) => e.endsWith(".svg")).map((e) => e.slice(0, -4)).filter((e) => !e.endsWith("-light") && !e.endsWith("-dark"));
	if (r.length === 0) throw Error("Dashboard Icons returned an invalid catalog.");
	return {
		icons: r,
		categories: []
	};
}
//#endregion
//#region src/data.ts
var y = [
	{
		id: "emoji",
		label: "Emoji"
	},
	{
		id: "lucide",
		label: "Lucide",
		iconifyPrefix: "lucide"
	},
	{
		id: "mdi",
		label: "Material",
		iconifyPrefix: "mdi"
	},
	{
		id: "ph",
		label: "Phosphor",
		iconifyPrefix: "ph"
	},
	{
		id: "dash",
		label: "Apps"
	},
	{
		id: "si",
		label: "Brands"
	}
], ae = [
	"#ffffff",
	"#94a3b8",
	"#3b82f6",
	"#8b5cf6",
	"#ec4899",
	"#f59e0b",
	"#10b981",
	"#06b6d4",
	"#ef4444",
	"#f97316"
], b = [
	"🚀",
	"⭐",
	"🎯",
	"🔥",
	"💡",
	"🎨",
	"📦",
	"🏠",
	"💰",
	"📊",
	"🔒",
	"⚡",
	"🌍",
	"📝",
	"🎵",
	"📸",
	"🛠️",
	"🎮",
	"📱",
	"💻",
	"🧪",
	"🔔",
	"💎",
	"🏆"
], x = /* @__PURE__ */ "home.settings.user.search.star.heart.plus.check.x.arrow-right.arrow-left.chevron-down.chevron-right.mail.calendar.clock.bell.bookmark.folder.file.image.video.music.camera.mic.phone.globe.map-pin.navigation.compass.sun.moon.cloud.zap.flame.rocket.target.flag.tag.hash.link.paperclip.scissors.copy.clipboard.trash-2.edit.eye.eye-off.lock.unlock.shield.key.database.server.code.terminal.git-branch.box.package.layers.layout.grid-3x3.list.bar-chart-3.pie-chart.trending-up.activity.cpu.wifi.download.upload.refresh-cw.alert-circle.info.help-circle.message-circle.send.external-link.filter".split("."), S = /* @__PURE__ */ "home.account.cog.magnify.star.heart.plus.check.close.arrow-right.arrow-left.chevron-down.email.calendar.clock.bell.bookmark.folder.file.image.video.music.camera.microphone.phone.earth.map-marker.navigation.weather-sunny.weather-night.cloud.flash.fire.rocket.target.flag.tag.link.paperclip.content-copy.clipboard.delete.pencil.eye.eye-off.lock.lock-open.shield.database.server.code-tags.console.source-branch.package.layers.view-dashboard.view-grid.view-list.chart-bar.chart-pie.trending-up.pulse.chip.wifi.download.upload.alert-circle.information.help-circle.message.send.open-in-new.filter".split("."), oe = /* @__PURE__ */ "house.gear.user.magnifying-glass.star.heart.plus.check.x.arrow-right.arrow-left.caret-down.envelope.calendar.clock.bell.bookmark-simple.folder.file.image.video-camera.music-note.camera.microphone.phone.globe.map-pin.navigation-arrow.sun.moon.cloud.lightning.fire.rocket.crosshair.flag.tag.link.paperclip.copy.clipboard.trash.pencil-simple.eye.eye-slash.lock.lock-open.shield.database.desktop.code.terminal.git-branch.package.stack.layout.squares-four.list-bullets.chart-bar.chart-pie.trend-up.activity.cpu.wifi-high.download.upload.warning-circle.info.question.chat-circle.paper-plane-tilt.arrow-square-out.funnel".split("."), C = /* @__PURE__ */ "github.gitlab.discord.slack.plex.jellyfin.sonarr.radarr.nextcloud.home-assistant.grafana.prometheus.portainer.nginx.traefik.docker.proxmox.unraid.pihole.adguard-home.bitwarden.vaultwarden.immich.photoprism.audiobookshelf.calibre.paperless-ngx.uptime-kuma.truenas.synology.qnap.cloudflare.tailscale.wireguard.opnsense.pfsense.ubuntu.debian.windows.linux.apple.android.google.microsoft.amazon.aws.azure.notion.obsidian.freshrss.miniflux".split("."), se = /* @__PURE__ */ "github.gitlab.bitbucket.docker.kubernetes.react.vuedotjs.angular.svelte.nextdotjs.typescript.javascript.python.go.rust.nodedotjs.deno.bun.npm.yarn.google.apple.microsoft.amazon.meta.slack.discord.telegram.whatsapp.signal.x.linkedin.instagram.youtube.twitch.reddit.stackoverflow.medium.devdotto.figma.sketch.canva.notion.obsidian.todoist.trello.jira.vercel.netlify.cloudflare.digitalocean.postgresql.mysql.mongodb.redis.sqlite.grafana.prometheus.elasticsearch.nginx.linux.ubuntu.visualstudiocode".split("."), ce = {
	lucide: x,
	mdi: S,
	ph: oe,
	dash: C,
	si: se
};
//#endregion
//#region src/iconify.ts
function le(e) {
	return typeof e == "object" && !!e && "icons" in e && typeof e.icons == "object" && e.icons !== null;
}
var w = /* @__PURE__ */ new Map(), T = 1e3;
function E(e, t) {
	return `${e}:${t}`;
}
function D(e, t, n) {
	let r = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${t} ${n}">${e}</svg>`;
	return `data:image/svg+xml,${encodeURIComponent(r)}`;
}
async function O(e, t, n) {
	if (![
		"lucide",
		"mdi",
		"ph"
	].includes(e) || t.length === 0) return {};
	let r = t.filter((t) => !w.has(E(e, t)));
	if (r.length > 0) try {
		let i = new URLSearchParams({ icons: r.join(",") }), a = await fetch(`https://api.iconify.design/${e}.json?${i}`, n ? { signal: n } : void 0);
		if (a.ok) {
			let n = await a.json();
			if (!le(n)) return Object.fromEntries(t.map((t) => [E(e, t), null]));
			for (let t of r) {
				let r = n.aliases?.[t], i = n.icons[t] ?? (r ? n.icons[r.parent] : void 0);
				if (!i) continue;
				let a = r?.width ?? i.width ?? n.width ?? 24, o = r?.height ?? i.height ?? n.height ?? 24;
				if (w.size >= T) {
					let e = w.keys().next().value;
					e && w.delete(e);
				}
				w.set(E(e, t), D(i.body, a, o));
			}
		}
	} catch {}
	return Object.fromEntries(t.map((t) => {
		let n = E(e, t);
		return [n, w.get(n) ?? null];
	}));
}
//#endregion
//#region src/theme.ts
var ue = [
	"--rs-icon-picker-bg",
	"--rs-icon-picker-surface",
	"--rs-icon-picker-surface-hover",
	"--rs-icon-picker-border",
	"--rs-icon-picker-text",
	"--rs-icon-picker-muted",
	"--rs-icon-picker-accent",
	"--rs-icon-picker-shadow",
	"--rs-icon-picker-notice-bg",
	"--rs-icon-picker-notice-text"
], k = typeof window > "u" ? l : d;
function A() {
	return typeof window < "u" && window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
function de(e, t) {
	if (e !== "auto") return e;
	let n = t?.parentElement ?? null;
	for (; n;) {
		let e = n.dataset.theme;
		if (e === "dark" || e === "light") return e;
		if (n.classList.contains("dark")) return "dark";
		let t = getComputedStyle(n).colorScheme.split(/\s+/).filter(Boolean);
		if (t.length === 1 && t[0] === "dark") return "dark";
		if (t.length === 1 && t[0] === "light") return "light";
		n = n.parentElement;
	}
	return A();
}
function fe(e, t) {
	let [n, r] = m(e === "dark" ? "dark" : "light");
	return k(() => {
		let n = () => r(de(e, t));
		if (n(), e !== "auto" || typeof window > "u") return;
		let i = window.matchMedia?.("(prefers-color-scheme: dark)");
		i?.addEventListener("change", n);
		let a = [], o = t?.parentElement ?? null;
		for (; o;) {
			let e = new MutationObserver(n);
			e.observe(o, {
				attributes: !0,
				attributeFilter: [
					"class",
					"style",
					"data-theme"
				]
			}), a.push(e), o = o.parentElement;
		}
		return () => {
			i?.removeEventListener("change", n);
			for (let e of a) e.disconnect();
		};
	}, [t, e]), n;
}
function j(e) {
	if (!e || typeof window > "u") return {};
	let t = {};
	for (let n of ue) {
		let r = e;
		for (; r;) {
			let e = getComputedStyle(r).getPropertyValue(n).trim();
			if (e) {
				t[n] = e;
				break;
			}
			r = r.parentElement;
		}
	}
	return t;
}
//#endregion
//#region src/IconPicker.tsx
var pe = o(() => import("emoji-picker-react")), M = null, N = /* @__PURE__ */ new Map(), P = 200;
function me(e, t) {
	if (typeof e != "object" || !e) return null;
	let n = e[t];
	return Array.isArray(n) ? n : null;
}
function he(e) {
	return Array.isArray(e) ? e : null;
}
function ge() {
	return /* @__PURE__ */ g("svg", {
		viewBox: "0 0 24 24",
		"aria-hidden": "true",
		className: "rs-icon-picker__svg",
		children: [/* @__PURE__ */ h("circle", {
			cx: "11",
			cy: "11",
			r: "7"
		}), /* @__PURE__ */ h("path", { d: "m20 20-3.5-3.5" })]
	});
}
function _e() {
	return /* @__PURE__ */ h("svg", {
		viewBox: "0 0 24 24",
		"aria-hidden": "true",
		className: "rs-icon-picker__svg",
		children: /* @__PURE__ */ h("path", { d: "M18 6 6 18M6 6l12 12" })
	});
}
function F() {
	return /* @__PURE__ */ h("span", {
		className: "rs-icon-picker__spinner",
		"aria-hidden": "true"
	});
}
async function ve(e, t) {
	M ??= import("emojilib");
	let { default: n } = await M, r = e.toLowerCase(), i = [];
	for (let [e, a] of Object.entries(n)) {
		if (i.length >= t) break;
		a.some((e) => e.includes(r)) && i.push(e);
	}
	return i;
}
async function ye(e, t, n, r) {
	let i = `${t}:${e}:${n}`, a = N.get(i);
	if (a) return a;
	let o = await fetch(`https://api.iconify.design/search?query=${encodeURIComponent(e)}&prefix=${t}&limit=${n}`, { signal: r });
	if (!o.ok) throw Error(`Iconify search returned HTTP ${o.status}.`);
	let s = await o.json(), c = he(s) ?? me(s, "icons");
	if (!c) throw Error("Iconify search returned an invalid response.");
	let l = c.filter((e) => typeof e == "string").map((e) => e.replace(`${t}:`, ""));
	if (N.size >= P) {
		let e = N.keys().next().value;
		e && N.delete(e);
	}
	return N.set(i, l), l;
}
function be(e) {
	return Array.from(e.querySelectorAll("button:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex=\"-1\"])")).filter((e) => !e.hasAttribute("hidden"));
}
var xe = s(function({ value: e, onChange: i, onClose: o, color: s, onColorChange: d, className: te, id: ne, ariaLabel: _ = "Choose an icon", searchDebounceMs: v = 200, modal: x = !1, theme: S = "auto", style: oe }) {
	let [le, w] = m(null), T = p(null), D = fe(S, le), ue = c((e) => {
		T.current = e, w(e);
	}, []), k = p(0), A = p(0), de = u(), j = ne ?? `rs-icon-picker-${de.replace(/:/g, "")}`, [M, N] = m(""), [P, me] = m(/* @__PURE__ */ new Set()), [he, xe] = m([]), [I, L] = m(!1), [R, Ce] = m(null), [z, B] = m(!1), [V, we] = m([]), [H, Te] = m([]), [Ee, De] = m({}), [U, Oe] = m(null), [W, ke] = m("all"), [Ae, je] = m(96), [Me, Ne] = m(!1), [Pe, Fe] = m(!1), [Ie, G] = m(!1), [Le, Re] = m(0), [ze, Be] = m({});
	l(() => {
		let e = new AbortController();
		return Promise.allSettled([ie(e.signal), re("si", e.signal)]).then(([t, n]) => {
			e.signal.aborted || (t.status === "fulfilled" && we(t.value.icons), n.status === "fulfilled" && Te(n.value.icons), De((e) => ({
				...e,
				...t.status === "fulfilled" ? { dash: t.value } : {},
				...n.status === "fulfilled" ? { si: n.value } : {}
			})), B(t.status === "rejected" || n.status === "rejected"));
		}), () => e.abort();
	}, []);
	let K = f(() => P.size === 0 ? y : y.filter((e) => P.has(e.id)), [P]);
	l(() => {
		let e = M.trim(), t = ++k.current;
		if (!e) return;
		let n = new AbortController(), r = setTimeout(() => {
			L(!0), Ce(null);
			let r = K.length <= 2 ? 48 : K.length <= 4 ? 32 : 24, i = e.toLowerCase(), a = K.map(async (t) => {
				if (t.id === "emoji") return {
					source: "emoji",
					label: t.label,
					icons: await ve(e, r)
				};
				if (t.iconifyPrefix) return {
					source: t.id,
					label: t.label,
					icons: await ye(e, t.iconifyPrefix, r, n.signal)
				};
				let a = t.id === "dash" ? V.length > 0 ? V : C : H.length > 0 ? H : se;
				return {
					source: t.id,
					label: t.label,
					icons: a.filter((e) => e.includes(i)).slice(0, r)
				};
			});
			Promise.allSettled(a).then((e) => {
				if (n.signal.aborted || t !== k.current) return;
				let r = e.flatMap((e) => e.status === "fulfilled" && e.value.icons.length > 0 ? [e.value] : []), i = e.filter((e) => e.status === "rejected").length;
				xe(r), Ce(i > 0 ? `${i === 1 ? "One provider is" : "Some providers are"} temporarily unavailable.` : null), L(!1);
			});
		}, Math.max(0, v));
		return () => {
			clearTimeout(r), n.abort();
		};
	}, [
		K,
		V,
		M,
		Le,
		v,
		H
	]);
	let Ve = f(() => {
		let e = K.length <= 2 ? 48 : K.length <= 4 ? 32 : 24;
		return K.map((t) => {
			if (t.id === "emoji") return {
				source: "emoji",
				label: t.label,
				icons: b
			};
			let n = t.id === "dash" && V.length > 0 ? V : t.id === "si" && H.length > 0 ? H : ce[t.id];
			return {
				source: t.id,
				label: t.label,
				icons: [...n.slice(0, e)]
			};
		});
	}, [
		K,
		V,
		H
	]), q = t(e), J = M.trim().length > 0, Y = J ? he : Ve, X = U ? y.find((e) => e.id === U) : void 0, Z = U ? Ee[U] : void 0, Q = f(() => Z && W !== "all" ? Z.categories.find((e) => e.name === W)?.icons ?? [] : Z?.icons ?? [], [Z, W]), $ = f(() => Q.slice(0, Ae), [Q, Ae]), He = f(() => U && !J && $.length > 0 ? [{
		source: U,
		label: X?.label ?? U,
		icons: $
	}] : Y, [
		U,
		X?.label,
		Y,
		J,
		$
	]), Ue = Y.reduce((e, t) => e + t.icons.length, 0);
	l(() => {
		let e = new AbortController(), t = He.filter((e) => [
			"lucide",
			"mdi",
			"ph"
		].includes(e.source));
		return t.length === 0 || Promise.all(t.map((t) => O(t.source, t.icons, e.signal))).then((t) => {
			e.signal.aborted || Be((e) => t.reduce((e, t) => ({
				...e,
				...t
			}), e));
		}), () => e.abort();
	}, [He]);
	function We(e) {
		Oe(null), G(!1), me((t) => {
			let n = new Set(t);
			return n.has(e) ? n.delete(e) : n.add(e), n;
		});
	}
	function Ge(e) {
		N(e), G(!1), e.trim() || (xe([]), L(!1), Ce(null));
	}
	function Ke(e, t) {
		i(n({
			source: e,
			name: t
		}));
	}
	async function qe(e) {
		let t = ++A.current;
		if (ke("all"), je(96), Fe(!1), e === "emoji") {
			G(!0), Oe(null);
			return;
		}
		if (G(!1), Oe(e), Ee[e]) {
			Ne(!1);
			return;
		}
		let n = new AbortController();
		Ne(!0);
		try {
			let t = e === "dash" ? await ie(n.signal) : await re(e, n.signal);
			De((n) => ({
				...n,
				[e]: t
			}));
		} catch {
			t === A.current && Fe(!0);
		} finally {
			t === A.current && Ne(!1);
		}
	}
	function Je(e) {
		if (e.key === "Escape" && o) {
			e.stopPropagation(), o();
			return;
		}
		if (!x || e.key !== "Tab" || !T.current) return;
		let t = be(T.current), n = t[0], r = t.at(-1);
		!n || !r || (e.shiftKey && document.activeElement === n ? (e.preventDefault(), r.focus()) : !e.shiftKey && document.activeElement === r && (e.preventDefault(), n.focus()));
	}
	return /* @__PURE__ */ g("div", {
		ref: ue,
		id: j,
		className: r("rs-icon-picker", te),
		"data-rs-icon-picker-theme": D,
		style: oe,
		role: x ? "dialog" : "region",
		"aria-modal": x || void 0,
		"aria-label": _,
		onKeyDown: Je,
		children: [
			/* @__PURE__ */ g("div", {
				className: "rs-icon-picker__search",
				children: [
					/* @__PURE__ */ h(ge, {}),
					/* @__PURE__ */ h("input", {
						type: "search",
						value: M,
						onChange: (e) => Ge(e.target.value),
						placeholder: "Search emoji, icons, brands...",
						"aria-label": "Search icons",
						autoFocus: x
					}),
					I && /* @__PURE__ */ h(F, {}),
					M && !I && /* @__PURE__ */ h("button", {
						type: "button",
						className: "rs-icon-picker__icon-button",
						onClick: () => Ge(""),
						"aria-label": "Clear search",
						children: /* @__PURE__ */ h(_e, {})
					}),
					o && /* @__PURE__ */ h("button", {
						type: "button",
						className: "rs-icon-picker__icon-button",
						onClick: o,
						"aria-label": "Close icon picker",
						children: /* @__PURE__ */ h(_e, {})
					})
				]
			}),
			/* @__PURE__ */ h("div", {
				className: "rs-icon-picker__filters",
				role: "group",
				"aria-label": "Icon sources",
				children: y.map((e) => {
					let t = P.size === 0 || P.has(e.id);
					return /* @__PURE__ */ h("button", {
						type: "button",
						onClick: () => We(e.id),
						className: r("rs-icon-picker__filter", t && "rs-icon-picker__filter--active"),
						"aria-pressed": t,
						children: e.label
					}, e.id);
				})
			}),
			d && /* @__PURE__ */ g("div", {
				className: "rs-icon-picker__colors",
				"aria-label": "Icon color",
				children: [/* @__PURE__ */ h("span", { children: "Color" }), /* @__PURE__ */ g("div", {
					className: "rs-icon-picker__color-options",
					children: [/* @__PURE__ */ h("button", {
						type: "button",
						onClick: () => d(""),
						className: r("rs-icon-picker__auto-color", !s && "rs-icon-picker__auto-color--selected"),
						"aria-label": "Use theme color",
						"aria-pressed": !s,
						children: "Auto"
					}), ae.map((e) => /* @__PURE__ */ h("button", {
						type: "button",
						onClick: () => d(e),
						className: r("rs-icon-picker__color", s === e && "rs-icon-picker__color--selected"),
						style: { backgroundColor: e },
						"aria-label": `Set icon color to ${e}`,
						"aria-pressed": s === e
					}, e))]
				})]
			}),
			/* @__PURE__ */ h("div", {
				className: "rs-icon-picker__results",
				children: Ie && !J ? /* @__PURE__ */ g(ee, { children: [/* @__PURE__ */ h("button", {
					type: "button",
					className: "rs-icon-picker__back",
					onClick: () => G(!1),
					children: "Back to all icons"
				}), /* @__PURE__ */ h(a, {
					fallback: /* @__PURE__ */ g("div", {
						className: "rs-icon-picker__state",
						role: "status",
						children: [/* @__PURE__ */ h(F, {}), " Loading emoji..."]
					}),
					children: /* @__PURE__ */ h(pe, {
						onEmojiClick: (e) => Ke("emoji", e.emoji),
						autoFocusSearch: !1,
						theme: D,
						height: 400,
						width: "100%",
						searchPlaceHolder: "Search emoji...",
						previewConfig: { showPreview: !1 }
					})
				})] }) : U && !J ? /* @__PURE__ */ g("section", {
					className: "rs-icon-picker__browser",
					"aria-labelledby": `${j}-browse-${U}`,
					children: [
						/* @__PURE__ */ g("div", {
							className: "rs-icon-picker__browser-heading",
							children: [/* @__PURE__ */ h("button", {
								type: "button",
								className: "rs-icon-picker__back",
								onClick: () => Oe(null),
								children: "Back"
							}), /* @__PURE__ */ g("div", { children: [/* @__PURE__ */ h("h2", {
								id: `${j}-browse-${U}`,
								children: X?.label ?? U
							}), Z && /* @__PURE__ */ g("span", { children: [Q.length.toLocaleString(), " icons"] })] })]
						}),
						Z && Z.categories.length > 0 && /* @__PURE__ */ g("div", {
							className: "rs-icon-picker__categories",
							"aria-label": "Icon categories",
							children: [/* @__PURE__ */ h("button", {
								type: "button",
								className: r("rs-icon-picker__category", W === "all" && "rs-icon-picker__category--active"),
								onClick: () => {
									ke("all"), je(96);
								},
								"aria-pressed": W === "all",
								children: "All"
							}), Z.categories.map((e) => /* @__PURE__ */ h("button", {
								type: "button",
								className: r("rs-icon-picker__category", W === e.name && "rs-icon-picker__category--active"),
								onClick: () => {
									ke(e.name), je(96);
								},
								"aria-pressed": W === e.name,
								children: e.name
							}, e.name))]
						}),
						Me ? /* @__PURE__ */ g("div", {
							className: "rs-icon-picker__state",
							role: "status",
							children: [
								/* @__PURE__ */ h(F, {}),
								" Loading ",
								X?.label ?? "icons",
								"..."
							]
						}) : Pe || !Z ? /* @__PURE__ */ g("div", {
							className: "rs-icon-picker__state",
							children: [/* @__PURE__ */ h("span", { children: "Could not load this catalog." }), /* @__PURE__ */ h("button", {
								type: "button",
								onClick: () => void qe(U),
								children: "Retry"
							})]
						}) : /* @__PURE__ */ g(ee, { children: [/* @__PURE__ */ h("div", {
							className: "rs-icon-picker__grid",
							children: $.map((e) => /* @__PURE__ */ h(Se, {
								name: e,
								source: U,
								color: U === "dash" || U === "si" ? void 0 : s,
								maskUrl: ze[E(U, e)],
								selected: q?.source === U && q.name === e,
								onClick: () => Ke(U, e)
							}, `${U}:${e}`))
						}), Ae < Q.length && /* @__PURE__ */ g("div", {
							className: "rs-icon-picker__load-more",
							children: [/* @__PURE__ */ h("button", {
								type: "button",
								onClick: () => je((e) => e + 96),
								children: "Load 96 more"
							}), /* @__PURE__ */ g("span", { children: [
								"Showing ",
								$.length.toLocaleString(),
								" of",
								" ",
								Q.length.toLocaleString()
							] })]
						})] })
					]
				}) : I && Y.length === 0 ? /* @__PURE__ */ g("div", {
					className: "rs-icon-picker__state",
					role: "status",
					children: [/* @__PURE__ */ h(F, {}), " Searching..."]
				}) : Y.length === 0 && J ? /* @__PURE__ */ g("div", {
					className: "rs-icon-picker__state",
					children: [/* @__PURE__ */ g("span", { children: [
						"No results for \"",
						M,
						"\"."
					] }), R && /* @__PURE__ */ h("button", {
						type: "button",
						onClick: () => Re((e) => e + 1),
						children: "Retry providers"
					})]
				}) : Y.map((e) => /* @__PURE__ */ g("section", {
					className: "rs-icon-picker__group",
					"aria-labelledby": `${j}-${e.source}`,
					children: [/* @__PURE__ */ g("div", {
						className: "rs-icon-picker__group-heading",
						children: [
							/* @__PURE__ */ h("h2", {
								id: `${j}-${e.source}`,
								children: e.label
							}),
							/* @__PURE__ */ h("span", { children: e.icons.length }),
							!J && /* @__PURE__ */ h("button", {
								type: "button",
								onClick: () => void qe(e.source),
								children: "Browse all"
							})
						]
					}), /* @__PURE__ */ h("div", {
						className: r("rs-icon-picker__grid", e.source === "emoji" && "rs-icon-picker__grid--emoji"),
						children: e.icons.map((t) => e.source === "emoji" ? /* @__PURE__ */ h("button", {
							type: "button",
							onClick: () => Ke("emoji", t),
							className: "rs-icon-picker__emoji",
							"aria-label": `Select emoji ${t}`,
							"aria-pressed": q?.source === "emoji" && q.name === t,
							children: t
						}, t) : /* @__PURE__ */ h(Se, {
							name: t,
							source: e.source,
							color: e.source === "dash" || e.source === "si" ? void 0 : s,
							maskUrl: ze[E(e.source, t)],
							selected: q?.source === e.source && q.name === t,
							onClick: () => Ke(e.source, t)
						}, `${e.source}:${t}`))
					})]
				}, e.source))
			}),
			/* @__PURE__ */ h("div", {
				className: "rs-icon-picker__announcer",
				"aria-live": "polite",
				children: J && !I ? `${Ue} icon${Ue === 1 ? "" : "s"} found.` : ""
			}),
			(R || z) && /* @__PURE__ */ h("div", {
				className: "rs-icon-picker__notice",
				role: "alert",
				children: R ?? "Live brand catalogs are unavailable; showing built-in icons."
			})
		]
	});
}), Se = s(function({ name: t, source: r, color: a, selected: o, maskUrl: s, onClick: c }) {
	let l = {
		source: r,
		name: t
	}, u = e(l, a), d = n(l), f = r === "lucide" || r === "mdi" || r === "ph";
	return /* @__PURE__ */ g("button", {
		type: "button",
		onClick: c,
		className: "rs-icon-picker__grid-item",
		"aria-label": `Select ${d}`,
		"aria-pressed": o,
		title: d,
		children: [f && s ? /* @__PURE__ */ h("span", {
			role: "img",
			"aria-label": d,
			className: "rs-icon-picker__grid-mask",
			style: {
				backgroundColor: a || "currentColor",
				maskImage: `url("${s}")`,
				WebkitMaskImage: `url("${s}")`
			}
		}) : f && s === void 0 ? /* @__PURE__ */ h("span", {
			className: "rs-icon-picker__grid-placeholder",
			"aria-hidden": "true"
		}) : f ? /* @__PURE__ */ h(i, {
			value: d,
			size: 22,
			color: a,
			label: "",
			fallback: /* @__PURE__ */ h("span", {
				className: "rs-icon-picker__broken-icon",
				"aria-hidden": "true",
				children: "!"
			})
		}) : u ? /* @__PURE__ */ h("img", {
			src: u,
			alt: "",
			width: 22,
			height: 22,
			loading: "lazy",
			decoding: "async",
			referrerPolicy: "no-referrer"
		}) : /* @__PURE__ */ h("span", {
			className: "rs-icon-picker__broken-icon",
			"aria-hidden": "true",
			children: "!"
		}), /* @__PURE__ */ h("span", { children: t.length > 10 ? `${t.slice(0, 10)}...` : t })]
	});
}), I = {
	sm: {
		className: "rs-icon-picker-trigger--sm",
		iconSize: 16
	},
	md: {
		className: "rs-icon-picker-trigger--md",
		iconSize: 20
	},
	lg: {
		className: "rs-icon-picker-trigger--lg",
		iconSize: 28
	}
}, L = 420, R = 520, Ce = 240, z = 8, B = 4, V = typeof window > "u" ? l : d;
function we(e, t, n) {
	let r = Math.max(1, Math.min(L, t - 16)), i = Math.max(0, n - e.bottom - B - z), a = Math.max(0, e.top - B - z), o = i < R && a > i, s = Math.max(1, n - 16), c = Math.max(a, i) < Math.min(Ce, s), l = c ? Math.min(R, s) : Math.min(R, o ? a : i), u = Math.min(Math.max(z, e.left), Math.max(z, t - z - r));
	return {
		top: c ? z : o ? Math.max(z, e.top - B - l) : Math.min(e.bottom + B, Math.max(z, n - z - l)),
		left: u,
		width: r,
		height: l
	};
}
function H({ value: e, onChange: t, onOpenChange: n, placeholder: a, size: o = "md", className: s, disabled: d = !1, color: f, pickerColor: ne = f, onColorChange: _, label: v = "Pick an icon", portalTarget: re, pickerProps: ie, theme: y = "auto", style: ae }) {
	let [b, x] = m(!1), [S, oe] = m(null), [C, se] = m(null), [ce, le] = m({}), w = p(null), T = p(null), E = `rs-icon-picker-${u().replace(/:/g, "")}`, D = I[o], O = fe(y, C), ue = c((e) => {
		w.current = e, se(e);
	}, []), k = c((e) => {
		x(e), n?.(e);
	}, [n]), A = c((e) => {
		k(!1), e && w.current?.focus();
	}, [k]);
	V(() => {
		if (!b) return;
		le(j(C));
		function e() {
			let e = w.current;
			if (!e) return;
			let t = we(e.getBoundingClientRect(), window.innerWidth, window.innerHeight);
			oe((e) => e && e.top === t.top && e.left === t.left && e.width === t.width && e.height === t.height ? e : t);
		}
		function t(t) {
			let n = t.target;
			n instanceof Node && T.current?.contains(n) || e();
		}
		return e(), window.addEventListener("resize", e), window.addEventListener("scroll", t, !0), () => {
			window.removeEventListener("resize", e), window.removeEventListener("scroll", t, !0);
		};
	}, [
		b,
		O,
		ae,
		C
	]), l(() => {
		if (!b) return;
		function e(e) {
			let t = e.target;
			t instanceof Node && (w.current?.contains(t) || T.current?.contains(t) || A(!1));
		}
		return document.addEventListener("pointerdown", e), () => document.removeEventListener("pointerdown", e);
	}, [A, b]);
	let de = typeof document > "u" ? null : re ?? document.body;
	return /* @__PURE__ */ g(ee, { children: [/* @__PURE__ */ h("button", {
		ref: ue,
		type: "button",
		onClick: () => {
			d || k(!b);
		},
		disabled: d,
		"aria-expanded": b,
		"aria-haspopup": "dialog",
		"aria-controls": E,
		"aria-label": v,
		title: v,
		className: r("rs-icon-picker-trigger", D.className, s),
		"data-rs-icon-picker-theme": O,
		style: ae,
		children: e ? /* @__PURE__ */ h(i, {
			value: e,
			size: D.iconSize,
			color: f,
			label: ""
		}) : a ?? /* @__PURE__ */ h("span", {
			className: "rs-icon-picker-trigger__placeholder",
			"aria-hidden": "true",
			children: "😀"
		})
	}), b && de && te(/* @__PURE__ */ h("div", {
		ref: T,
		className: "rs-icon-picker-popover",
		"data-rs-icon-picker-theme": O,
		onMouseDown: (e) => e.stopPropagation(),
		style: {
			...ce,
			top: S?.top ?? 0,
			left: S?.left ?? 0,
			width: S?.width ?? L,
			height: S?.height ?? R,
			visibility: S ? "visible" : "hidden"
		},
		children: /* @__PURE__ */ h(xe, {
			...ie,
			id: E,
			value: e,
			onChange: (e) => {
				t(e), A(!0);
			},
			onClose: () => A(!0),
			color: ne,
			onColorChange: _,
			modal: !0,
			theme: O
		})
	}), de)] });
}
//#endregion
export { xe as n, H as t };

//# sourceMappingURL=IconPickerButton-5VFx_PZY.js.map