import { getIconUrl as e, parseIconValue as t } from "../core.js";
import { memo as n, useState as r } from "react";
import { Fragment as i, jsx as a, jsxs as o } from "react/jsx-runtime";
//#region src/classnames.ts
function s(...e) {
	return e.filter(Boolean).join(" ");
}
//#endregion
//#region src/IconRenderer.tsx
var c = n(function({ value: n, size: c = 20, color: l, className: u, label: d, fallback: f = null }) {
	let [p, m] = r(null), h = t(n), g = Number.isFinite(c) && c > 0 ? c : 20;
	if (!h) return /* @__PURE__ */ a(i, { children: f });
	let _ = d === void 0 ? h.source === "emoji" ? `Emoji: ${h.name}` : `${h.source} icon: ${h.name}` : d;
	if (h.source === "emoji") return /* @__PURE__ */ a("span", {
		className: s("rs-icon-picker__renderer-emoji", u),
		style: {
			fontSize: g * .85,
			width: g,
			height: g
		},
		role: _ ? "img" : void 0,
		"aria-label": _ || void 0,
		"aria-hidden": !_ || void 0,
		children: h.name
	});
	let v = e(h, l);
	return !v || p === v ? /* @__PURE__ */ a(i, { children: f }) : !l && (h.source === "lucide" || h.source === "mdi" || h.source === "ph") ? /* @__PURE__ */ o(i, { children: [/* @__PURE__ */ a("span", {
		role: _ ? "img" : void 0,
		"aria-label": _ || void 0,
		"aria-hidden": !_ || void 0,
		className: s("rs-icon-picker__renderer-mask", u),
		style: {
			width: g,
			height: g,
			maskImage: `url("${v}")`,
			WebkitMaskImage: `url("${v}")`
		}
	}), /* @__PURE__ */ a("img", {
		src: v,
		alt: "",
		"aria-hidden": "true",
		width: 0,
		height: 0,
		className: "rs-icon-picker__renderer-probe",
		onError: () => m(v)
	})] }) : /* @__PURE__ */ a("img", {
		src: v,
		alt: _,
		"aria-hidden": !_ || void 0,
		width: g,
		height: g,
		loading: "lazy",
		decoding: "async",
		referrerPolicy: "no-referrer",
		className: s("rs-icon-picker__renderer-image", u),
		style: {
			width: g,
			height: g
		},
		onError: () => m(v)
	});
});
//#endregion
export { s as n, c as t };

//# sourceMappingURL=IconRenderer-86b851bX.js.map