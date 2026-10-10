//#region src/core.ts
var e = /^[\p{Emoji_Presentation}\p{Extended_Pictographic}]/u, t = /^(lucide|mdi|ph|dash|si):(.+)$/, n = /^[a-z][a-z0-9-]*$/, r = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/, i = /^#?([a-fA-F0-9]{3}|[a-fA-F0-9]{4}|[a-fA-F0-9]{6}|[a-fA-F0-9]{8})$/, a = {
	pihole: "pi-hole",
	ubuntu: "ubuntu-linux",
	debian: "debian-linux",
	windows: "microsoft-windows",
	tandoor: "tandoor-recipes"
}, o = { twitter: "x" }, s = {
	"+": "plus",
	".": "dot",
	"&": "and",
	đ: "d",
	ħ: "h",
	ı: "i",
	ĸ: "k",
	ŀ: "l",
	ł: "l",
	ß: "ss",
	ŧ: "t",
	ø: "o"
};
function c(r) {
	if (!r) return null;
	let i = t.exec(r);
	return i?.[1] && i[2] ? {
		source: i[1],
		name: i[2]
	} : e.test(r) ? {
		source: "emoji",
		name: r
	} : n.test(r) ? {
		source: "lucide",
		name: r
	} : {
		source: "emoji",
		name: r
	};
}
function l(e) {
	return e.source === "emoji" ? e.name : `${e.source}:${e.name}`;
}
function u(e) {
	return e ? i.exec(e)?.[1] ?? null : null;
}
function d(e) {
	return e.toLowerCase().replace(/[+.&đħıĸŀłßŧø]/g, (e) => s[e] ?? e).normalize("NFD").replace(/[^a-z\d]/g, "");
}
function f(e) {
	let t = [];
	return Array.isArray(e) ? t = e : e && typeof e == "object" && ("uncategorized" in e && Array.isArray(e.uncategorized) ? t = e.uncategorized : "icons" in e && Array.isArray(e.icons) && (t = e.icons)), t.flatMap((e) => {
		if (typeof e == "string") return [e];
		if (!e || typeof e != "object") return [];
		let t = "slug" in e && typeof e.slug == "string" ? e.slug : "", n = "title" in e && typeof e.title == "string" ? e.title : "", r = t || d(n);
		return r ? [r] : [];
	});
}
function p(e, t) {
	if (e.source === "emoji" || !r.test(e.name)) return null;
	let n = u(t), i = n ? `?color=%23${n}` : "";
	switch (e.source) {
		case "lucide":
		case "mdi":
		case "ph": return `https://api.iconify.design/${e.source}/${e.name}.svg${i}`;
		case "dash": return `https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/${a[e.name] ?? e.name}.svg`;
		case "si": return `https://cdn.simpleicons.org/${o[e.name] ?? e.name}${n ? `/${n}` : ""}`;
	}
}
//#endregion
export { p as getIconUrl, f as getSimpleIconNames, c as parseIconValue, l as serializeIconValue };

//# sourceMappingURL=core.js.map