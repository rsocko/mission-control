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
var D = /* @__PURE__ */ new Map(), re = 1e3;
function O(e, t) {
	return `${e}:${t}`;
}
function ie(e, t, n) {
	let r = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${t} ${n}">${e}</svg>`;
	return `data:image/svg+xml,${encodeURIComponent(r)}`;
}
async function k(e, t, n) {
	if (![
		"lucide",
		"mdi",
		"ph"
	].includes(e) || t.length === 0) return {};
	let r = t.filter((t) => !D.has(O(e, t)));
	if (r.length > 0) try {
		let i = new URLSearchParams({ icons: r.join(",") }), a = await fetch(`https://api.iconify.design/${e}.json?${i}`, n ? { signal: n } : void 0);
		if (a.ok) {
			let n = await a.json();
			if (!E(n)) return Object.fromEntries(t.map((t) => [O(e, t), null]));
			for (let t of r) {
				let r = n.aliases?.[t], i = n.icons[t] ?? (r ? n.icons[r.parent] : void 0);
				if (!i) continue;
				let a = r?.width ?? i.width ?? n.width ?? 24, o = r?.height ?? i.height ?? n.height ?? 24;
				if (D.size >= re) {
					let e = D.keys().next().value;
					e && D.delete(e);
				}
				D.set(O(e, t), ie(i.body, a, o));
			}
		}
	} catch {}
	return Object.fromEntries(t.map((t) => {
		let n = O(e, t);
		return [n, D.get(n) ?? null];
	}));
}
//#endregion
//#region src/theme.ts
var A = [
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
], j = typeof window > "u" ? u : f;
function M() {
	return typeof window < "u" && window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
function N(e, t) {
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
	return M();
}
function ae(e, t) {
	let [n, r] = h(e === "dark" ? "dark" : "light");
	return j(() => {
		let n = () => r(N(e, t));
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
function oe(e) {
	if (!e || typeof window > "u") return {};
	let t = {};
	for (let n of A) {
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
var se = s(() => import("emoji-picker-react")), P = null, F = /* @__PURE__ */ new Map(), I = 200;
function L(e, t) {
	if (typeof e != "object" || !e) return null;
	let n = e[t];
	return Array.isArray(n) ? n : null;
}
function ce(e) {
	return Array.isArray(e) ? e : null;
}
function le() {
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
function ue() {
	return /* @__PURE__ */ g("svg", {
		viewBox: "0 0 24 24",
		"aria-hidden": "true",
		className: "rs-icon-picker__svg",
		children: /* @__PURE__ */ g("path", { d: "M18 6 6 18M6 6l12 12" })
	});
}
function R() {
	return /* @__PURE__ */ g("span", {
		className: "rs-icon-picker__spinner",
		"aria-hidden": "true"
	});
}
async function de(e, t) {
	P ??= import("emojilib");
	let { default: n } = await P, r = e.toLowerCase(), i = [];
	for (let [e, a] of Object.entries(n)) {
		if (i.length >= t) break;
		a.some((e) => e.includes(r)) && i.push(e);
	}
	return i;
}
async function fe(e, t, n, r) {
	let i = `${t}:${e}:${n}`, a = F.get(i);
	if (a) return a;
	let o = await fetch(`https://api.iconify.design/search?query=${encodeURIComponent(e)}&prefix=${t}&limit=${n}`, { signal: r });
	if (!o.ok) throw Error(`Iconify search returned HTTP ${o.status}.`);
	let s = await o.json(), c = ce(s) ?? L(s, "icons");
	if (!c) throw Error("Iconify search returned an invalid response.");
	let l = c.filter((e) => typeof e == "string").map((e) => e.replace(`${t}:`, ""));
	if (F.size >= I) {
		let e = F.keys().next().value;
		e && F.delete(e);
	}
	return F.set(i, l), l;
}
async function pe(e) {
	let t = await fetch("https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons@main/tree.json", { signal: e });
	if (!t.ok) throw Error(`Dashboard Icons returned HTTP ${t.status}.`);
	let n = L(await t.json(), "svg");
	if (!n) throw Error("Dashboard Icons returned an invalid catalog.");
	return n.filter((e) => typeof e == "string" && e.endsWith(".svg")).map((e) => e.slice(0, -4)).filter((e) => !e.endsWith("-light") && !e.endsWith("-dark"));
}
async function me(e) {
	let n = await fetch("https://api.iconify.design/collection?prefix=simple-icons", { signal: e });
	if (!n.ok) throw Error(`Simple Icons returned HTTP ${n.status}.`);
	let r = t(await n.json());
	if (r.length === 0) throw Error("Simple Icons returned an invalid catalog.");
	return r;
}
function he(e) {
	return Array.from(e.querySelectorAll("button:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex=\"-1\"])")).filter((e) => !e.hasAttribute("hidden"));
}
var z = c(function({ value: e, onChange: t, onClose: a, color: s, onColorChange: c, className: f, id: te, ariaLabel: b = "Choose an icon", searchDebounceMs: x = 200, modal: S = !1, theme: E = "auto", style: D }) {
	let [re, ie] = h(null), A = m(null), j = ae(E, re), M = l((e) => {
		A.current = e, ie(e);
	}, []), N = m(0), oe = d(), P = te ?? `rs-icon-picker-${oe.replace(/:/g, "")}`, [F, I] = h(""), [L, ce] = h(/* @__PURE__ */ new Set()), [z, B] = h([]), [V, H] = h(!1), [U, W] = h(null), [G, _e] = h(!1), [K, ve] = h([]), [q, ye] = h([]), [be, J] = h(!1), [xe, Se] = h(0), [Ce, we] = h({});
	u(() => {
		let e = new AbortController();
		return Promise.allSettled([pe(e.signal), me(e.signal)]).then(([t, n]) => {
			e.signal.aborted || (t.status === "fulfilled" && ve(t.value), n.status === "fulfilled" && ye(n.value), _e(t.status === "rejected" || n.status === "rejected"));
		}), () => e.abort();
	}, []);
	let Y = p(() => L.size === 0 ? v : v.filter((e) => L.has(e.id)), [L]);
	u(() => {
		let e = F.trim(), t = ++N.current;
		if (!e) return;
		let n = new AbortController(), r = setTimeout(() => {
			H(!0), W(null);
			let r = Y.length <= 2 ? 48 : Y.length <= 4 ? 32 : 24, i = e.toLowerCase(), a = Y.map(async (t) => {
				if (t.id === "emoji") return {
					source: "emoji",
					label: t.label,
					icons: await de(e, r)
				};
				if (t.iconifyPrefix) return {
					source: t.id,
					label: t.label,
					icons: await fe(e, t.iconifyPrefix, r, n.signal)
				};
				let a = t.id === "dash" ? K.length > 0 ? K : C : q.length > 0 ? q : w;
				return {
					source: t.id,
					label: t.label,
					icons: a.filter((e) => e.includes(i)).slice(0, r)
				};
			});
			Promise.allSettled(a).then((e) => {
				if (n.signal.aborted || t !== N.current) return;
				let r = e.flatMap((e) => e.status === "fulfilled" && e.value.icons.length > 0 ? [e.value] : []), i = e.filter((e) => e.status === "rejected").length;
				B(r), W(i > 0 ? `${i === 1 ? "One provider is" : "Some providers are"} temporarily unavailable.` : null), H(!1);
			});
		}, Math.max(0, x));
		return () => {
			clearTimeout(r), n.abort();
		};
	}, [
		Y,
		K,
		F,
		xe,
		x,
		q
	]);
	let Te = p(() => {
		let e = Y.length <= 2 ? 48 : Y.length <= 4 ? 32 : 24;
		return Y.map((t) => {
			if (t.id === "emoji") return {
				source: "emoji",
				label: t.label,
				icons: ne
			};
			let n = t.id === "dash" && K.length > 0 ? K : t.id === "si" && q.length > 0 ? q : T[t.id];
			return {
				source: t.id,
				label: t.label,
				icons: [...n.slice(0, e)]
			};
		});
	}, [
		Y,
		K,
		q
	]), X = n(e), Z = F.trim().length > 0, Q = Z ? z : Te, Ee = Q.reduce((e, t) => e + t.icons.length, 0);
	u(() => {
		let e = new AbortController(), t = Q.filter((e) => [
			"lucide",
			"mdi",
			"ph"
		].includes(e.source));
		return t.length === 0 || Promise.all(t.map((t) => k(t.source, t.icons, e.signal))).then((t) => {
			e.signal.aborted || we((e) => t.reduce((e, t) => ({
				...e,
				...t
			}), e));
		}), () => e.abort();
	}, [Q]);
	function De(e) {
		ce((t) => {
			let n = new Set(t);
			return n.has(e) ? n.delete(e) : n.add(e), n;
		});
	}
	function Oe(e) {
		I(e), J(!1), e.trim() || (B([]), H(!1), W(null));
	}
	function $(e, n) {
		t(r({
			source: e,
			name: n
		}));
	}
	function ke(e) {
		if (e.key === "Escape" && a) {
			e.stopPropagation(), a();
			return;
		}
		if (!S || e.key !== "Tab" || !A.current) return;
		let t = he(A.current), n = t[0], r = t.at(-1);
		!n || !r || (e.shiftKey && document.activeElement === n ? (e.preventDefault(), r.focus()) : !e.shiftKey && document.activeElement === r && (e.preventDefault(), n.focus()));
	}
	return /* @__PURE__ */ _("div", {
		ref: M,
		id: P,
		className: i("rs-icon-picker", f),
		"data-rs-icon-picker-theme": j,
		style: D,
		role: S ? "dialog" : "region",
		"aria-modal": S || void 0,
		"aria-label": b,
		onKeyDown: ke,
		children: [
			/* @__PURE__ */ _("div", {
				className: "rs-icon-picker__search",
				children: [
					/* @__PURE__ */ g(le, {}),
					/* @__PURE__ */ g("input", {
						type: "search",
						value: F,
						onChange: (e) => Oe(e.target.value),
						placeholder: "Search emoji, icons, brands...",
						"aria-label": "Search icons",
						autoFocus: S
					}),
					V && /* @__PURE__ */ g(R, {}),
					F && !V && /* @__PURE__ */ g("button", {
						type: "button",
						className: "rs-icon-picker__icon-button",
						onClick: () => Oe(""),
						"aria-label": "Clear search",
						children: /* @__PURE__ */ g(ue, {})
					}),
					a && /* @__PURE__ */ g("button", {
						type: "button",
						className: "rs-icon-picker__icon-button",
						onClick: a,
						"aria-label": "Close icon picker",
						children: /* @__PURE__ */ g(ue, {})
					})
				]
			}),
			/* @__PURE__ */ g("div", {
				className: "rs-icon-picker__filters",
				role: "group",
				"aria-label": "Icon sources",
				children: v.map((e) => {
					let t = L.size === 0 || L.has(e.id);
					return /* @__PURE__ */ g("button", {
						type: "button",
						onClick: () => De(e.id),
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
				children: be && !Z ? /* @__PURE__ */ _(ee, { children: [/* @__PURE__ */ g("button", {
					type: "button",
					className: "rs-icon-picker__back",
					onClick: () => J(!1),
					children: "Back to all icons"
				}), /* @__PURE__ */ g(o, {
					fallback: /* @__PURE__ */ _("div", {
						className: "rs-icon-picker__state",
						role: "status",
						children: [/* @__PURE__ */ g(R, {}), " Loading emoji..."]
					}),
					children: /* @__PURE__ */ g(se, {
						onEmojiClick: (e) => $("emoji", e.emoji),
						autoFocusSearch: !1,
						theme: j,
						height: 400,
						width: "100%",
						searchPlaceHolder: "Search emoji...",
						previewConfig: { showPreview: !1 }
					})
				})] }) : V && Q.length === 0 ? /* @__PURE__ */ _("div", {
					className: "rs-icon-picker__state",
					role: "status",
					children: [/* @__PURE__ */ g(R, {}), " Searching..."]
				}) : Q.length === 0 && Z ? /* @__PURE__ */ _("div", {
					className: "rs-icon-picker__state",
					children: [/* @__PURE__ */ _("span", { children: [
						"No results for \"",
						F,
						"\"."
					] }), U && /* @__PURE__ */ g("button", {
						type: "button",
						onClick: () => Se((e) => e + 1),
						children: "Retry providers"
					})]
				}) : Q.map((e) => /* @__PURE__ */ _("section", {
					className: "rs-icon-picker__group",
					"aria-labelledby": `${P}-${e.source}`,
					children: [/* @__PURE__ */ _("div", {
						className: "rs-icon-picker__group-heading",
						children: [
							/* @__PURE__ */ g("h2", {
								id: `${P}-${e.source}`,
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
						}, t) : /* @__PURE__ */ g(ge, {
							name: t,
							source: e.source,
							color: e.source === "dash" || e.source === "si" ? void 0 : s,
							maskUrl: Ce[O(e.source, t)],
							selected: X?.source === e.source && X.name === t,
							onClick: () => $(e.source, t)
						}, `${e.source}:${t}`))
					})]
				}, e.source))
			}),
			/* @__PURE__ */ g("div", {
				className: "rs-icon-picker__announcer",
				"aria-live": "polite",
				children: Z && !V ? `${Ee} icon${Ee === 1 ? "" : "s"} found.` : ""
			}),
			(U || G) && /* @__PURE__ */ g("div", {
				className: "rs-icon-picker__notice",
				role: "alert",
				children: U ?? "Live brand catalogs are unavailable; showing built-in icons."
			})
		]
	});
}), ge = c(function({ name: t, source: n, color: i, selected: o, maskUrl: s, onClick: c }) {
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
}), B = {
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
}, V = 420, H = 520, U = 240, W = 8, G = 4, _e = typeof window > "u" ? u : f;
function K(e, t, n) {
	let r = Math.max(1, Math.min(V, t - 16)), i = Math.max(0, n - e.bottom - G - W), a = Math.max(0, e.top - G - W), o = i < H && a > i, s = Math.max(1, n - 16), c = Math.max(a, i) < Math.min(U, s), l = c ? Math.min(H, s) : Math.min(H, o ? a : i), u = Math.min(Math.max(W, e.left), Math.max(W, t - W - r));
	return {
		top: c ? W : o ? Math.max(W, e.top - G - l) : Math.min(e.bottom + G, Math.max(W, n - W - l)),
		left: u,
		width: r,
		height: l
	};
}
function ve({ value: e, onChange: t, onOpenChange: n, placeholder: r, size: o = "md", className: s, disabled: c = !1, color: f, pickerColor: p = f, onColorChange: v, label: y = "Pick an icon", portalTarget: ne, pickerProps: b, theme: x = "auto", style: S }) {
	let [C, w] = h(!1), [T, E] = h(null), [D, re] = h(null), [O, ie] = h({}), k = m(null), A = m(null), j = `rs-icon-picker-${d().replace(/:/g, "")}`, M = B[o], N = ae(x, D), se = l((e) => {
		k.current = e, re(e);
	}, []), P = l((e) => {
		w(e), n?.(e);
	}, [n]), F = l((e) => {
		P(!1), e && k.current?.focus();
	}, [P]);
	_e(() => {
		if (!C) return;
		ie(oe(D));
		function e() {
			let e = k.current;
			if (!e) return;
			let t = K(e.getBoundingClientRect(), window.innerWidth, window.innerHeight);
			E((e) => e && e.top === t.top && e.left === t.left && e.width === t.width && e.height === t.height ? e : t);
		}
		function t(t) {
			let n = t.target;
			n instanceof Node && A.current?.contains(n) || e();
		}
		return e(), window.addEventListener("resize", e), window.addEventListener("scroll", t, !0), () => {
			window.removeEventListener("resize", e), window.removeEventListener("scroll", t, !0);
		};
	}, [
		C,
		N,
		S,
		D
	]), u(() => {
		if (!C) return;
		function e(e) {
			let t = e.target;
			t instanceof Node && (k.current?.contains(t) || A.current?.contains(t) || F(!1));
		}
		return document.addEventListener("pointerdown", e), () => document.removeEventListener("pointerdown", e);
	}, [F, C]);
	let I = typeof document > "u" ? null : ne ?? document.body;
	return /* @__PURE__ */ _(ee, { children: [/* @__PURE__ */ g("button", {
		ref: se,
		type: "button",
		onClick: () => {
			c || P(!C);
		},
		disabled: c,
		"aria-expanded": C,
		"aria-haspopup": "dialog",
		"aria-controls": j,
		"aria-label": y,
		title: y,
		className: i("rs-icon-picker-trigger", M.className, s),
		"data-rs-icon-picker-theme": N,
		style: S,
		children: e ? /* @__PURE__ */ g(a, {
			value: e,
			size: M.iconSize,
			color: f,
			label: ""
		}) : r ?? /* @__PURE__ */ g("span", {
			className: "rs-icon-picker-trigger__placeholder",
			"aria-hidden": "true",
			children: "😀"
		})
	}), C && I && te(/* @__PURE__ */ g("div", {
		ref: A,
		className: "rs-icon-picker-popover",
		"data-rs-icon-picker-theme": N,
		onMouseDown: (e) => e.stopPropagation(),
		style: {
			...O,
			top: T?.top ?? 0,
			left: T?.left ?? 0,
			width: T?.width ?? V,
			height: T?.height ?? H,
			visibility: T ? "visible" : "hidden"
		},
		children: /* @__PURE__ */ g(z, {
			...b,
			id: j,
			value: e,
			onChange: (e) => {
				t(e), F(!0);
			},
			onClose: () => F(!0),
			color: p,
			onColorChange: v,
			modal: !0,
			theme: N
		})
	}), I)] });
}
//#endregion
export { z as n, ve as t };

//# sourceMappingURL=IconPickerButton-BjUqdo6t.js.map