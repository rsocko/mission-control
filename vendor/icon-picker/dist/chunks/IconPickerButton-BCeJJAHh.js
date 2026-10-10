import { getIconUrl as e, getSimpleIconNames as t, parseIconValue as n, serializeIconValue as r } from "../core.js";
import { n as i, t as a } from "./IconRenderer-86b851bX.js";
import { Suspense as o, lazy as s, memo as c, useCallback as l, useEffect as u, useId as d, useLayoutEffect as f, useMemo as p, useRef as m, useState as h } from "react";
import { Fragment as ee, jsx as g, jsxs as _ } from "react/jsx-runtime";
import { createPortal as te } from "react-dom";
//#region src/data.ts
var v = [
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
], y = [
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
], ne = [
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
], b = /* @__PURE__ */ "home.settings.user.search.star.heart.plus.check.x.arrow-right.arrow-left.chevron-down.chevron-right.mail.calendar.clock.bell.bookmark.folder.file.image.video.music.camera.mic.phone.globe.map-pin.navigation.compass.sun.moon.cloud.zap.flame.rocket.target.flag.tag.hash.link.paperclip.scissors.copy.clipboard.trash-2.edit.eye.eye-off.lock.unlock.shield.key.database.server.code.terminal.git-branch.box.package.layers.layout.grid-3x3.list.bar-chart-3.pie-chart.trending-up.activity.cpu.wifi.download.upload.refresh-cw.alert-circle.info.help-circle.message-circle.send.external-link.filter".split("."), x = /* @__PURE__ */ "home.account.cog.magnify.star.heart.plus.check.close.arrow-right.arrow-left.chevron-down.email.calendar.clock.bell.bookmark.folder.file.image.video.music.camera.microphone.phone.earth.map-marker.navigation.weather-sunny.weather-night.cloud.flash.fire.rocket.target.flag.tag.link.paperclip.content-copy.clipboard.delete.pencil.eye.eye-off.lock.lock-open.shield.database.server.code-tags.console.source-branch.package.layers.view-dashboard.view-grid.view-list.chart-bar.chart-pie.trending-up.pulse.chip.wifi.download.upload.alert-circle.information.help-circle.message.send.open-in-new.filter".split("."), S = /* @__PURE__ */ "house.gear.user.magnifying-glass.star.heart.plus.check.x.arrow-right.arrow-left.caret-down.envelope.calendar.clock.bell.bookmark-simple.folder.file.image.video-camera.music-note.camera.microphone.phone.globe.map-pin.navigation-arrow.sun.moon.cloud.lightning.fire.rocket.crosshair.flag.tag.link.paperclip.copy.clipboard.trash.pencil-simple.eye.eye-slash.lock.lock-open.shield.database.desktop.code.terminal.git-branch.package.stack.layout.squares-four.list-bullets.chart-bar.chart-pie.trend-up.activity.cpu.wifi-high.download.upload.warning-circle.info.question.chat-circle.paper-plane-tilt.arrow-square-out.funnel".split("."), C = /* @__PURE__ */ "github.gitlab.discord.slack.plex.jellyfin.sonarr.radarr.nextcloud.home-assistant.grafana.prometheus.portainer.nginx.traefik.docker.proxmox.unraid.pihole.adguard-home.bitwarden.vaultwarden.immich.photoprism.audiobookshelf.calibre.paperless-ngx.uptime-kuma.truenas.synology.qnap.cloudflare.tailscale.wireguard.opnsense.pfsense.ubuntu.debian.windows.linux.apple.android.google.microsoft.amazon.aws.azure.notion.obsidian.freshrss.miniflux".split("."), w = /* @__PURE__ */ "github.gitlab.bitbucket.docker.kubernetes.react.vuedotjs.angular.svelte.nextdotjs.typescript.javascript.python.go.rust.nodedotjs.deno.bun.npm.yarn.google.apple.microsoft.amazon.meta.slack.discord.telegram.whatsapp.signal.x.linkedin.instagram.youtube.twitch.reddit.stackoverflow.medium.devdotto.figma.sketch.canva.notion.obsidian.todoist.trello.jira.vercel.netlify.cloudflare.digitalocean.postgresql.mysql.mongodb.redis.sqlite.grafana.prometheus.elasticsearch.nginx.linux.ubuntu.visualstudiocode".split("."), T = {
	lucide: b,
	mdi: x,
	ph: S,
	dash: C,
	si: w
};
//#endregion
//#region src/iconify.ts
function E(e) {
	return typeof e == "object" && !!e && "icons" in e && typeof e.icons == "object" && e.icons !== null;
}
var D = /* @__PURE__ */ new Map(), O = 1e3;
function k(e, t) {
	return `${e}:${t}`;
}
function A(e, t, n) {
	let r = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${t} ${n}">${e}</svg>`;
	return `data:image/svg+xml,${encodeURIComponent(r)}`;
}
async function j(e, t, n) {
	if (![
		"lucide",
		"mdi",
		"ph"
	].includes(e) || t.length === 0) return {};
	let r = t.filter((t) => !D.has(k(e, t)));
	if (r.length > 0) try {
		let i = new URLSearchParams({ icons: r.join(",") }), a = await fetch(`https://api.iconify.design/${e}.json?${i}`, n ? { signal: n } : void 0);
		if (a.ok) {
			let n = await a.json();
			if (!E(n)) return Object.fromEntries(t.map((t) => [k(e, t), null]));
			for (let t of r) {
				let r = n.aliases?.[t], i = n.icons[t] ?? (r ? n.icons[r.parent] : void 0);
				if (!i) continue;
				let a = r?.width ?? i.width ?? n.width ?? 24, o = r?.height ?? i.height ?? n.height ?? 24;
				if (D.size >= O) {
					let e = D.keys().next().value;
					e && D.delete(e);
				}
				D.set(k(e, t), A(i.body, a, o));
			}
		}
	} catch {}
	return Object.fromEntries(t.map((t) => {
		let n = k(e, t);
		return [n, D.get(n) ?? null];
	}));
}
//#endregion
//#region src/IconPicker.tsx
var re = s(() => import("emoji-picker-react")), M = null, N = /* @__PURE__ */ new Map(), ie = 200;
function P(e, t) {
	if (typeof e != "object" || !e) return null;
	let n = e[t];
	return Array.isArray(n) ? n : null;
}
function F(e) {
	return Array.isArray(e) ? e : null;
}
function ae() {
	return /* @__PURE__ */ _("svg", {
		viewBox: "0 0 24 24",
		"aria-hidden": "true",
		className: "rs-icon-picker__svg",
		children: [/* @__PURE__ */ g("circle", {
			cx: "11",
			cy: "11",
			r: "7"
		}), /* @__PURE__ */ g("path", { d: "m20 20-3.5-3.5" })]
	});
}
function I() {
	return /* @__PURE__ */ g("svg", {
		viewBox: "0 0 24 24",
		"aria-hidden": "true",
		className: "rs-icon-picker__svg",
		children: /* @__PURE__ */ g("path", { d: "M18 6 6 18M6 6l12 12" })
	});
}
function L() {
	return /* @__PURE__ */ g("span", {
		className: "rs-icon-picker__spinner",
		"aria-hidden": "true"
	});
}
async function oe(e, t) {
	M ??= import("emojilib");
	let { default: n } = await M, r = e.toLowerCase(), i = [];
	for (let [e, a] of Object.entries(n)) {
		if (i.length >= t) break;
		a.some((e) => e.includes(r)) && i.push(e);
	}
	return i;
}
async function se(e, t, n, r) {
	let i = `${t}:${e}:${n}`, a = N.get(i);
	if (a) return a;
	let o = await fetch(`https://api.iconify.design/search?query=${encodeURIComponent(e)}&prefix=${t}&limit=${n}`, { signal: r });
	if (!o.ok) throw Error(`Iconify search returned HTTP ${o.status}.`);
	let s = await o.json(), c = F(s) ?? P(s, "icons");
	if (!c) throw Error("Iconify search returned an invalid response.");
	let l = c.filter((e) => typeof e == "string").map((e) => e.replace(`${t}:`, ""));
	if (N.size >= ie) {
		let e = N.keys().next().value;
		e && N.delete(e);
	}
	return N.set(i, l), l;
}
async function ce(e) {
	let t = await fetch("https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons@main/tree.json", { signal: e });
	if (!t.ok) throw Error(`Dashboard Icons returned HTTP ${t.status}.`);
	let n = P(await t.json(), "svg");
	if (!n) throw Error("Dashboard Icons returned an invalid catalog.");
	return n.filter((e) => typeof e == "string" && e.endsWith(".svg")).map((e) => e.slice(0, -4)).filter((e) => !e.endsWith("-light") && !e.endsWith("-dark"));
}
async function le(e) {
	let n = await fetch("https://api.iconify.design/collection?prefix=simple-icons", { signal: e });
	if (!n.ok) throw Error(`Simple Icons returned HTTP ${n.status}.`);
	let r = t(await n.json());
	if (r.length === 0) throw Error("Simple Icons returned an invalid catalog.");
	return r;
}
function ue(e) {
	return Array.from(e.querySelectorAll("button:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex=\"-1\"])")).filter((e) => !e.hasAttribute("hidden"));
}
var R = c(function({ value: e, onChange: t, onClose: a, color: s, onColorChange: c, className: l, id: f, ariaLabel: te = "Choose an icon", searchDebounceMs: b = 200, modal: x = !1 }) {
	let S = m(null), E = m(0), D = d(), O = f ?? `rs-icon-picker-${D.replace(/:/g, "")}`, [A, M] = h(""), [N, ie] = h(/* @__PURE__ */ new Set()), [P, F] = h([]), [R, z] = h(!1), [B, V] = h(null), [H, U] = h(!1), [W, G] = h([]), [K, q] = h([]), [fe, J] = h(!1), [pe, me] = h(0), [he, ge] = h({});
	u(() => {
		let e = new AbortController();
		return Promise.allSettled([ce(e.signal), le(e.signal)]).then(([t, n]) => {
			e.signal.aborted || (t.status === "fulfilled" && G(t.value), n.status === "fulfilled" && q(n.value), U(t.status === "rejected" || n.status === "rejected"));
		}), () => e.abort();
	}, []);
	let Y = p(() => N.size === 0 ? v : v.filter((e) => N.has(e.id)), [N]);
	u(() => {
		let e = A.trim(), t = ++E.current;
		if (!e) return;
		let n = new AbortController(), r = setTimeout(() => {
			z(!0), V(null);
			let r = Y.length <= 2 ? 48 : Y.length <= 4 ? 32 : 24, i = e.toLowerCase(), a = Y.map(async (t) => {
				if (t.id === "emoji") return {
					source: "emoji",
					label: t.label,
					icons: await oe(e, r)
				};
				if (t.iconifyPrefix) return {
					source: t.id,
					label: t.label,
					icons: await se(e, t.iconifyPrefix, r, n.signal)
				};
				let a = t.id === "dash" ? W.length > 0 ? W : C : K.length > 0 ? K : w;
				return {
					source: t.id,
					label: t.label,
					icons: a.filter((e) => e.includes(i)).slice(0, r)
				};
			});
			Promise.allSettled(a).then((e) => {
				if (n.signal.aborted || t !== E.current) return;
				let r = e.flatMap((e) => e.status === "fulfilled" && e.value.icons.length > 0 ? [e.value] : []), i = e.filter((e) => e.status === "rejected").length;
				F(r), V(i > 0 ? `${i === 1 ? "One provider is" : "Some providers are"} temporarily unavailable.` : null), z(!1);
			});
		}, Math.max(0, b));
		return () => {
			clearTimeout(r), n.abort();
		};
	}, [
		Y,
		W,
		A,
		pe,
		b,
		K
	]);
	let _e = p(() => {
		let e = Y.length <= 2 ? 48 : Y.length <= 4 ? 32 : 24;
		return Y.map((t) => {
			if (t.id === "emoji") return {
				source: "emoji",
				label: t.label,
				icons: ne
			};
			let n = t.id === "dash" && W.length > 0 ? W : t.id === "si" && K.length > 0 ? K : T[t.id];
			return {
				source: t.id,
				label: t.label,
				icons: [...n.slice(0, e)]
			};
		});
	}, [
		Y,
		W,
		K
	]), X = n(e), Z = A.trim().length > 0, Q = Z ? P : _e, ve = Q.reduce((e, t) => e + t.icons.length, 0);
	u(() => {
		let e = new AbortController(), t = Q.filter((e) => [
			"lucide",
			"mdi",
			"ph"
		].includes(e.source));
		return t.length === 0 || Promise.all(t.map((t) => j(t.source, t.icons, e.signal))).then((t) => {
			e.signal.aborted || ge((e) => t.reduce((e, t) => ({
				...e,
				...t
			}), e));
		}), () => e.abort();
	}, [Q]);
	function ye(e) {
		ie((t) => {
			let n = new Set(t);
			return n.has(e) ? n.delete(e) : n.add(e), n;
		});
	}
	function be(e) {
		M(e), J(!1), e.trim() || (F([]), z(!1), V(null));
	}
	function $(e, n) {
		t(r({
			source: e,
			name: n
		}));
	}
	function xe(e) {
		if (e.key === "Escape" && a) {
			e.stopPropagation(), a();
			return;
		}
		if (!x || e.key !== "Tab" || !S.current) return;
		let t = ue(S.current), n = t[0], r = t.at(-1);
		!n || !r || (e.shiftKey && document.activeElement === n ? (e.preventDefault(), r.focus()) : !e.shiftKey && document.activeElement === r && (e.preventDefault(), n.focus()));
	}
	return /* @__PURE__ */ _("div", {
		ref: S,
		id: O,
		className: i("rs-icon-picker", l),
		role: x ? "dialog" : "region",
		"aria-modal": x || void 0,
		"aria-label": te,
		onKeyDown: xe,
		children: [
			/* @__PURE__ */ _("div", {
				className: "rs-icon-picker__search",
				children: [
					/* @__PURE__ */ g(ae, {}),
					/* @__PURE__ */ g("input", {
						type: "search",
						value: A,
						onChange: (e) => be(e.target.value),
						placeholder: "Search emoji, icons, brands...",
						"aria-label": "Search icons",
						autoFocus: x
					}),
					R && /* @__PURE__ */ g(L, {}),
					A && !R && /* @__PURE__ */ g("button", {
						type: "button",
						className: "rs-icon-picker__icon-button",
						onClick: () => be(""),
						"aria-label": "Clear search",
						children: /* @__PURE__ */ g(I, {})
					}),
					a && /* @__PURE__ */ g("button", {
						type: "button",
						className: "rs-icon-picker__icon-button",
						onClick: a,
						"aria-label": "Close icon picker",
						children: /* @__PURE__ */ g(I, {})
					})
				]
			}),
			/* @__PURE__ */ g("div", {
				className: "rs-icon-picker__filters",
				role: "group",
				"aria-label": "Icon sources",
				children: v.map((e) => {
					let t = N.size === 0 || N.has(e.id);
					return /* @__PURE__ */ g("button", {
						type: "button",
						onClick: () => ye(e.id),
						className: i("rs-icon-picker__filter", t && "rs-icon-picker__filter--active"),
						"aria-pressed": t,
						children: e.label
					}, e.id);
				})
			}),
			c && /* @__PURE__ */ _("div", {
				className: "rs-icon-picker__colors",
				"aria-label": "Icon color",
				children: [/* @__PURE__ */ g("span", { children: "Color" }), /* @__PURE__ */ _("div", {
					className: "rs-icon-picker__color-options",
					children: [/* @__PURE__ */ g("button", {
						type: "button",
						onClick: () => c(""),
						className: i("rs-icon-picker__auto-color", !s && "rs-icon-picker__auto-color--selected"),
						"aria-label": "Use theme color",
						"aria-pressed": !s,
						children: "Auto"
					}), y.map((e) => /* @__PURE__ */ g("button", {
						type: "button",
						onClick: () => c(e),
						className: i("rs-icon-picker__color", s === e && "rs-icon-picker__color--selected"),
						style: { backgroundColor: e },
						"aria-label": `Set icon color to ${e}`,
						"aria-pressed": s === e
					}, e))]
				})]
			}),
			/* @__PURE__ */ g("div", {
				className: "rs-icon-picker__results",
				children: fe && !Z ? /* @__PURE__ */ _(ee, { children: [/* @__PURE__ */ g("button", {
					type: "button",
					className: "rs-icon-picker__back",
					onClick: () => J(!1),
					children: "Back to all icons"
				}), /* @__PURE__ */ g(o, {
					fallback: /* @__PURE__ */ _("div", {
						className: "rs-icon-picker__state",
						role: "status",
						children: [/* @__PURE__ */ g(L, {}), " Loading emoji..."]
					}),
					children: /* @__PURE__ */ g(re, {
						onEmojiClick: (e) => $("emoji", e.emoji),
						autoFocusSearch: !1,
						theme: "auto",
						height: 400,
						width: "100%",
						searchPlaceHolder: "Search emoji...",
						previewConfig: { showPreview: !1 }
					})
				})] }) : R && Q.length === 0 ? /* @__PURE__ */ _("div", {
					className: "rs-icon-picker__state",
					role: "status",
					children: [/* @__PURE__ */ g(L, {}), " Searching..."]
				}) : Q.length === 0 && Z ? /* @__PURE__ */ _("div", {
					className: "rs-icon-picker__state",
					children: [/* @__PURE__ */ _("span", { children: [
						"No results for \"",
						A,
						"\"."
					] }), B && /* @__PURE__ */ g("button", {
						type: "button",
						onClick: () => me((e) => e + 1),
						children: "Retry providers"
					})]
				}) : Q.map((e) => /* @__PURE__ */ _("section", {
					className: "rs-icon-picker__group",
					"aria-labelledby": `${O}-${e.source}`,
					children: [/* @__PURE__ */ _("div", {
						className: "rs-icon-picker__group-heading",
						children: [
							/* @__PURE__ */ g("h2", {
								id: `${O}-${e.source}`,
								children: e.label
							}),
							/* @__PURE__ */ g("span", { children: e.icons.length }),
							e.source === "emoji" && !Z && /* @__PURE__ */ g("button", {
								type: "button",
								onClick: () => J(!0),
								children: "Browse all"
							})
						]
					}), /* @__PURE__ */ g("div", {
						className: i("rs-icon-picker__grid", e.source === "emoji" && "rs-icon-picker__grid--emoji"),
						children: e.icons.map((t) => e.source === "emoji" ? /* @__PURE__ */ g("button", {
							type: "button",
							onClick: () => $("emoji", t),
							className: "rs-icon-picker__emoji",
							"aria-label": `Select emoji ${t}`,
							"aria-pressed": X?.source === "emoji" && X.name === t,
							children: t
						}, t) : /* @__PURE__ */ g(de, {
							name: t,
							source: e.source,
							color: e.source === "dash" || e.source === "si" ? void 0 : s,
							maskUrl: he[k(e.source, t)],
							selected: X?.source === e.source && X.name === t,
							onClick: () => $(e.source, t)
						}, `${e.source}:${t}`))
					})]
				}, e.source))
			}),
			/* @__PURE__ */ g("div", {
				className: "rs-icon-picker__announcer",
				"aria-live": "polite",
				children: Z && !R ? `${ve} icon${ve === 1 ? "" : "s"} found.` : ""
			}),
			(B || H) && /* @__PURE__ */ g("div", {
				className: "rs-icon-picker__notice",
				role: "alert",
				children: B ?? "Live brand catalogs are unavailable; showing built-in icons."
			})
		]
	});
}), de = c(function({ name: t, source: n, color: i, selected: o, maskUrl: s, onClick: c }) {
	let l = {
		source: n,
		name: t
	}, u = e(l, i), d = r(l), f = n === "lucide" || n === "mdi" || n === "ph";
	return /* @__PURE__ */ _("button", {
		type: "button",
		onClick: c,
		className: "rs-icon-picker__grid-item",
		"aria-label": `Select ${d}`,
		"aria-pressed": o,
		title: d,
		children: [f && s ? /* @__PURE__ */ g("span", {
			role: "img",
			"aria-label": d,
			className: "rs-icon-picker__grid-mask",
			style: {
				backgroundColor: i || "currentColor",
				maskImage: `url("${s}")`,
				WebkitMaskImage: `url("${s}")`
			}
		}) : f && s === void 0 ? /* @__PURE__ */ g("span", {
			className: "rs-icon-picker__grid-placeholder",
			"aria-hidden": "true"
		}) : f ? /* @__PURE__ */ g(a, {
			value: d,
			size: 22,
			color: i,
			label: "",
			fallback: /* @__PURE__ */ g("span", {
				className: "rs-icon-picker__broken-icon",
				"aria-hidden": "true",
				children: "!"
			})
		}) : u ? /* @__PURE__ */ g("img", {
			src: u,
			alt: "",
			width: 22,
			height: 22,
			loading: "lazy",
			decoding: "async",
			referrerPolicy: "no-referrer"
		}) : /* @__PURE__ */ g("span", {
			className: "rs-icon-picker__broken-icon",
			"aria-hidden": "true",
			children: "!"
		}), /* @__PURE__ */ g("span", { children: t.length > 10 ? `${t.slice(0, 10)}...` : t })]
	});
}), z = {
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
}, B = 420, V = 520, H = 240, U = 8, W = 4, G = typeof window > "u" ? u : f;
function K(e, t, n) {
	let r = Math.max(1, Math.min(B, t - 16)), i = Math.max(0, n - e.bottom - W - U), a = Math.max(0, e.top - W - U), o = i < V && a > i, s = Math.max(1, n - 16), c = Math.max(a, i) < Math.min(H, s), l = c ? Math.min(V, s) : Math.min(V, o ? a : i), u = Math.min(Math.max(U, e.left), Math.max(U, t - U - r));
	return {
		top: c ? U : o ? Math.max(U, e.top - W - l) : Math.min(e.bottom + W, Math.max(U, n - U - l)),
		left: u,
		width: r,
		height: l
	};
}
function q({ value: e, onChange: t, onOpenChange: n, placeholder: r, size: o = "md", className: s, disabled: c = !1, color: f, pickerColor: p = f, onColorChange: v, label: y = "Pick an icon", portalTarget: ne, pickerProps: b }) {
	let [x, S] = h(!1), [C, w] = h(null), T = m(null), E = m(null), D = `rs-icon-picker-${d().replace(/:/g, "")}`, O = z[o], k = l((e) => {
		S(e), n?.(e);
	}, [n]), A = l((e) => {
		k(!1), e && T.current?.focus();
	}, [k]);
	G(() => {
		if (!x) return;
		function e() {
			let e = T.current;
			if (!e) return;
			let t = K(e.getBoundingClientRect(), window.innerWidth, window.innerHeight);
			w((e) => e && e.top === t.top && e.left === t.left && e.width === t.width && e.height === t.height ? e : t);
		}
		function t(t) {
			let n = t.target;
			n instanceof Node && E.current?.contains(n) || e();
		}
		return e(), window.addEventListener("resize", e), window.addEventListener("scroll", t, !0), () => {
			window.removeEventListener("resize", e), window.removeEventListener("scroll", t, !0);
		};
	}, [x]), u(() => {
		if (!x) return;
		function e(e) {
			let t = e.target;
			t instanceof Node && (T.current?.contains(t) || E.current?.contains(t) || A(!1));
		}
		return document.addEventListener("pointerdown", e), () => document.removeEventListener("pointerdown", e);
	}, [A, x]);
	let j = typeof document > "u" ? null : ne ?? document.body;
	return /* @__PURE__ */ _(ee, { children: [/* @__PURE__ */ g("button", {
		ref: T,
		type: "button",
		onClick: () => {
			c || k(!x);
		},
		disabled: c,
		"aria-expanded": x,
		"aria-haspopup": "dialog",
		"aria-controls": D,
		"aria-label": y,
		title: y,
		className: i("rs-icon-picker-trigger", O.className, s),
		children: e ? /* @__PURE__ */ g(a, {
			value: e,
			size: O.iconSize,
			color: f,
			label: ""
		}) : r ?? /* @__PURE__ */ g("span", {
			className: "rs-icon-picker-trigger__placeholder",
			"aria-hidden": "true",
			children: "😀"
		})
	}), x && j && te(/* @__PURE__ */ g("div", {
		ref: E,
		className: "rs-icon-picker-popover",
		onMouseDown: (e) => e.stopPropagation(),
		style: {
			top: C?.top ?? 0,
			left: C?.left ?? 0,
			width: C?.width ?? B,
			height: C?.height ?? V,
			visibility: C ? "visible" : "hidden"
		},
		children: /* @__PURE__ */ g(R, {
			...b,
			id: D,
			value: e,
			onChange: (e) => {
				t(e), A(!0);
			},
			onClose: () => A(!0),
			color: p,
			onColorChange: v,
			modal: !0
		})
	}), j)] });
}
//#endregion
export { R as n, q as t };

//# sourceMappingURL=IconPickerButton-BCeJJAHh.js.map