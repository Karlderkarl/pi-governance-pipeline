// yaml.mjs — the YAML subset the pipeline contract is written in.
//
// Supports block maps and block sequences by indentation, inline maps
// `{ a: b }`, inline lists `[a, b]`, quoted and plain scalars, booleans,
// integers, null, and `#` comments. Quotes are respected everywhere a comma or
// colon could otherwise split a value: a gate command such as
// `eslint --ext .js,.ts src` must survive intact. Anything the subset does not
// cover (block scalars `|` / `>`, anchors, tags, complex keys) is a contract
// error that names the construct, never a silent misparse.
//
// No dependency: pi installs packages with `npm install`, so one would be
// possible, but the contract is small enough that a parser we own is the
// safer choice. It is exercised by tests/unit/yaml.test.mjs.

export function contractError(message) {
	const error = new Error(message);
	error.code = "CONTRACT";
	return error;
}

const UNSUPPORTED = [
	[/^[|>][+-]?\d*\s*$/, "a block scalar (| or >)"],
	[/^&/, "an anchor (&)"],
	[/^\*[A-Za-z]/, "an alias (*)"],
	[/^!!?[A-Za-z]/, "a tag (!)"],
	[/^\?\s/, "a complex key (?)"],
];

function unsupported(value, where) {
	for (const [re, name] of UNSUPPORTED) {
		if (re.test(value)) {
			throw contractError(`AGENTS.md ${where} uses ${name}, which the contract subset does not support; write a plain or quoted scalar`);
		}
	}
}

// Comment stripping that knows about quotes: `run: "echo # not a comment"`.
export function stripComment(line) {
	let out = "";
	let quote = null;
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (quote) {
			if (c === "\\" && quote === '"' && i + 1 < line.length) {
				out += c + line[i + 1];
				i++;
				continue;
			}
			if (c === quote) quote = null;
		} else if (c === '"' || c === "'") {
			quote = c;
		} else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
			break;
		}
		out += c;
	}
	return out;
}

// Index of the first `ch` outside quotes and outside nested braces/brackets,
// or -1. Used for the key/value colon and for inline separators.
function indexOutsideQuotes(text, ch, { depthAware = true } = {}) {
	let quote = null;
	let depth = 0;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (quote) {
			if (c === "\\" && quote === '"') {
				i++;
				continue;
			}
			if (c === quote) quote = null;
			continue;
		}
		if (c === '"' || c === "'") {
			quote = c;
			continue;
		}
		if (depthAware) {
			if (c === "{" || c === "[") depth++;
			else if (c === "}" || c === "]") depth--;
		}
		if (c === ch && depth === 0) return i;
	}
	return -1;
}

// Split on top-level commas, quote-aware. `"a,b"` stays one part.
export function splitTopLevel(text) {
	const parts = [];
	let quote = null;
	let depth = 0;
	let current = "";
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (quote) {
			current += c;
			if (c === "\\" && quote === '"' && i + 1 < text.length) {
				current += text[i + 1];
				i++;
				continue;
			}
			if (c === quote) quote = null;
			continue;
		}
		if (c === '"' || c === "'") {
			quote = c;
			current += c;
			continue;
		}
		if (c === "{" || c === "[") depth++;
		if (c === "}" || c === "]") depth--;
		if (c === "," && depth === 0) {
			parts.push(current);
			current = "";
		} else current += c;
	}
	if (current.trim() !== "") parts.push(current);
	return parts;
}

function unquote(value) {
	if (/^".*"$/s.test(value)) {
		return value
			.slice(1, -1)
			.replace(/\\(["\\/bfnrt])/g, (_, c) => ({ '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" })[c]);
	}
	if (/^'.*'$/s.test(value)) return value.slice(1, -1).replace(/''/g, "'");
	return null;
}

export function parseScalar(value, where = "value") {
	const v = value.trim();
	if (v === "") return null;
	unsupported(v, where);
	if (v.startsWith("{") && v.endsWith("}")) {
		const map = {};
		for (const part of splitTopLevel(v.slice(1, -1))) {
			const i = indexOutsideQuotes(part, ":");
			if (i === -1) {
				if (part.trim() === "") continue;
				throw contractError(`AGENTS.md ${where}: inline map entry \`${part.trim()}\` has no key`);
			}
			const key = parseKey(part.slice(0, i), where);
			if (Object.hasOwn(map, key)) throw contractError(`AGENTS.md ${where}: duplicate key \`${key}\` in inline map`);
			map[key] = parseScalar(part.slice(i + 1), `${where}.${key}`);
		}
		return map;
	}
	if (v.startsWith("[") && v.endsWith("]")) {
		return splitTopLevel(v.slice(1, -1))
			.filter((p) => p.trim() !== "")
			.map((p) => parseScalar(p, where));
	}
	const quoted = unquote(v);
	if (quoted !== null) return quoted;
	if (v === "true" || v === "True" || v === "TRUE") return true;
	if (v === "false" || v === "False" || v === "FALSE") return false;
	if (v === "null" || v === "~" || v === "Null" || v === "NULL") return null;
	if (/^-?\d+$/.test(v)) return Number.parseInt(v, 10);
	if (/^-?\d+\.\d+$/.test(v)) return Number.parseFloat(v);
	return v;
}

function parseKey(raw, where) {
	const key = raw.trim();
	const quoted = unquote(key);
	if (quoted !== null) return quoted;
	if (key === "") throw contractError(`AGENTS.md ${where}: empty key`);
	return key;
}

// Lines carry their indent and their content; blank and comment-only lines
// are dropped before structure is decided.
function toLines(text) {
	const lines = [];
	let n = 0;
	for (const raw of text.split(/\r?\n/)) {
		n++;
		const line = stripComment(raw.replace(/\t/g, "  "));
		if (!line.trim()) continue;
		lines.push({ n, indent: line.length - line.trimStart().length, text: line.trim() });
	}
	return lines;
}

const isSeqItem = (t) => t === "-" || t.startsWith("- ");

// A map entry is `key:` followed by a space, end of line, or an inline value.
function splitMapEntry(text) {
	const i = indexOutsideQuotes(text, ":", { depthAware: false });
	if (i === -1) return null;
	const after = text[i + 1];
	if (after !== undefined && after !== " " && after !== "\t") return null;
	return { key: text.slice(0, i), rest: text.slice(i + 1).trim() };
}

export function parseYamlSubset(text) {
	const lines = toLines(text);
	if (lines.length === 0) return {};
	const { value, next } = parseNode(lines, 0, lines[0].indent, "config");
	if (next < lines.length) {
		throw contractError(`AGENTS.md line ${lines[next].n}: unexpected indentation (\`${lines[next].text}\`)`);
	}
	return value;
}

function parseNode(lines, i, indent, where) {
	if (isSeqItem(lines[i].text)) return parseSequence(lines, i, indent, where);
	return parseMap(lines, i, indent, where);
}

function parseMap(lines, start, indent, where) {
	const map = {};
	let i = start;
	while (i < lines.length && lines[i].indent === indent) {
		const line = lines[i];
		if (isSeqItem(line.text)) break;
		const entry = splitMapEntry(line.text);
		if (!entry) {
			throw contractError(`AGENTS.md line ${line.n}: expected \`key: value\`, got \`${line.text}\``);
		}
		const key = parseKey(entry.key, where);
		const path = where === "config" ? key : `${where}.${key}`;
		// Last-wins would let a second `implement:` silently replace the first.
		if (Object.hasOwn(map, key)) throw contractError(`AGENTS.md line ${line.n}: duplicate key \`${path}\``);
		i++;
		if (entry.rest !== "") {
			map[key] = parseScalar(entry.rest, path);
			continue;
		}
		// Nested block: deeper indent, or a sequence at the same indent.
		if (i < lines.length && (lines[i].indent > indent || (lines[i].indent === indent && isSeqItem(lines[i].text)))) {
			const child = parseNode(lines, i, lines[i].indent, path);
			map[key] = child.value;
			i = child.next;
		} else {
			map[key] = null;
		}
	}
	if (i < lines.length && lines[i].indent > indent) {
		throw contractError(`AGENTS.md line ${lines[i].n}: unexpected indentation (\`${lines[i].text}\`)`);
	}
	return { value: map, next: i };
}

function parseSequence(lines, start, indent, where) {
	const list = [];
	let i = start;
	while (i < lines.length && lines[i].indent === indent && isSeqItem(lines[i].text)) {
		const line = lines[i];
		const rest = line.text === "-" ? "" : line.text.slice(2).trim();
		const path = `${where}[${list.length}]`;
		if (isSeqItem(rest)) {
			throw contractError(`AGENTS.md line ${line.n}: ${path} is a nested sequence (\`- - …\`), which the contract subset does not support`);
		}
		i++;
		if (rest === "") {
			if (i < lines.length && lines[i].indent > indent) {
				const child = parseNode(lines, i, lines[i].indent, path);
				list.push(child.value);
				i = child.next;
			} else list.push(null);
			continue;
		}
		const entry = splitMapEntry(rest);
		const startsInline = rest.startsWith("{") || rest.startsWith("[") || rest.startsWith('"') || rest.startsWith("'");
		if (entry && !startsInline) {
			// `- key: value` opens a map whose further keys sit at the column
			// of `key` on the following lines.
			const itemIndent = indent + 2 + (line.text.length - 2 - rest.length);
			const item = {};
			const key = parseKey(entry.key, path);
			if (entry.rest !== "") item[key] = parseScalar(entry.rest, `${path}.${key}`);
			else if (i < lines.length && lines[i].indent > itemIndent) {
				const child = parseNode(lines, i, lines[i].indent, `${path}.${key}`);
				item[key] = child.value;
				i = child.next;
			} else item[key] = null;
			if (i < lines.length && lines[i].indent === itemIndent && !isSeqItem(lines[i].text)) {
				const more = parseMap(lines, i, itemIndent, path);
				for (const k of Object.keys(more.value)) {
					if (Object.hasOwn(item, k)) throw contractError(`AGENTS.md line ${lines[i].n}: duplicate key \`${path}.${k}\``);
				}
				Object.assign(item, more.value);
				i = more.next;
			}
			list.push(item);
			continue;
		}
		list.push(parseScalar(rest, path));
	}
	return { value: list, next: i };
}
