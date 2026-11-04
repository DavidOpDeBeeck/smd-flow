#!/usr/bin/env node
// Draws what a change does to the SMD message flows of an application, as one diagram in a light and a dark image.
//
//   node render.mjs <head.smdflow> --base <base.smdflow> [--changed <Command,...>] [--out <name>]
//
// Writes <name>-light.svg, <name>-dark.svg and <name>.md (default name: smd-flow): a short description of the change
// and a <picture> that shows the image matching the reader's theme. --changed names commands whose fields or handling
// the change alters without rewiring them: the diff of two flows cannot see that, so they and their handler are drawn
// as changed. Icons tell the kind of node; colour tells what the change does to it in that flow: green new, amber
// changed, blue reused here, red removed here.

import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

const USAGE = 'usage: render.mjs <head.smdflow> --base <base.smdflow> [--changed <Command,...>] [--out <name>]';

const MEDIA = {
    'sync': { tier: 0, label: 'sync', says: 'runs on the publishing thread inside the command\'s transaction, and a failure rolls the command back' },
    'async-await': { tier: 1, label: 'async, awaited', says: 'runs on virtual threads outside the transaction while the publisher waits for it' },
    'event-store': { tier: 2, label: 'event store', says: 'is stored with the events in the transaction and delivered later by polling; it is retried and then abandoned after max-retries' },
    'durable': { tier: 2, label: 'durable dispatcher', says: 'is stored in the transaction and delivered later, in order per subject, retried until it succeeds' },
    'async-fire-and-forget': { tier: 3, label: 'fire and forget', says: 'is not awaited; failures are only logged and the work is lost on a crash' },
};
const media = name => MEDIA[name] ?? { tier: 2, label: name, says: `is delivered through ${name}` };
const SUFFIX = { cmd: 'Command', q: 'Query', ev: 'Event' };
const show = (name, kind) => name.endsWith(SUFFIX[kind]) && name.length > SUFFIX[kind].length ? name.slice(0, -SUFFIX[kind].length) : name;

/* ------------------------------------------------------------------ parsing */

function parse(source, path) {
    const flow = { title: '', owners: [], families: {}, groups: [], queryOwners: [] };
    const errors = [], warnings = [], handled = [], sent = [], reads = [];
    const commandOwner = new Map();
    let block = null;

    source.split('\n').forEach((raw, index) => {
        const at = `${path}:${index + 1}`;
        const line = raw.replace(/#.*$/, '').trimEnd();
        if (!line.trim()) return;
        const words = line.trim().split(/\s+/);

        if (!/^\s/.test(line)) {
            block = null;
            const [keyword, name] = words;
            if (keyword === 'app') { flow.title = name ?? ''; return; }
            if (!name) { errors.push(`${at}: '${keyword}' needs a name`); return; }
            if (keyword === 'events') {
                flow.families[name.replace(/:$/, '')] = words.slice(2);
            } else if (keyword === 'aggregate' || keyword === 'handler') {
                if (flow.owners.some(o => o.name === name)) errors.push(`${at}: ${name} is declared twice`);
                block = { type: 'owner', name, commands: [] };
                flow.owners.push(block);
            } else if (keyword === 'queries') {
                if (flow.queryOwners.some(o => o.name === name)) errors.push(`${at}: queries ${name} is declared twice`);
                block = { type: 'queries', name, queries: [] };
                flow.queryOwners.push(block);
            } else if (keyword === 'group') {
                if (flow.groups.some(g => g.name === name)) errors.push(`${at}: group ${name} is declared twice`);
                const medium = words[2];
                if (!medium) errors.push(`${at}: group ${name} needs a medium (${Object.keys(MEDIA).join(', ')})`);
                else if (!MEDIA[medium]) warnings.push(`${at}: group ${name} uses medium '${medium}', which is not built into SMD; it is drawn as a custom medium`);
                block = { type: 'group', name, medium: medium ?? 'sync', handles: [], sends: [] };
                flow.groups.push(block);
            } else {
                errors.push(`${at}: unknown keyword '${keyword}'; expected app, events, aggregate, handler, group or queries`);
            }
            return;
        }

        if (!block) { errors.push(`${at}: indented line outside an aggregate, handler, group or queries block`); return; }
        if (block.type === 'owner') {
            if (!line.includes('->')) { errors.push(`${at}: expected '<Command> -> <Event> ...' in ${block.name}`); return; }
            const [command, events = ''] = line.split('->').map(part => part.trim());
            if (!command) { errors.push(`${at}: missing command name before '->'`); return; }
            if (commandOwner.has(command)) errors.push(`${at}: ${command} is already handled by ${commandOwner.get(command)}`);
            commandOwner.set(command, block.name);
            block.commands.push({ name: command, events: events.split(/[\s,]+/).filter(Boolean) });
        } else if (block.type === 'queries') {
            const [query, keyword, ...groups] = words;
            if (keyword !== 'reads') { errors.push(`${at}: expected '<Query> reads <group> ...' in queries ${block.name}`); return; }
            block.queries.push({ name: query, reads: groups });
            groups.forEach(group => reads.push({ at, query, group }));
        } else if (words[0] === 'handles' || words[0] === 'sends') {
            block[words[0]].push(...words.slice(1));
            words.slice(1).forEach(name => (words[0] === 'handles' ? handled : sent).push({ at, group: block.name, name }));
        } else {
            errors.push(`${at}: unknown group entry '${words[0]}'; expected handles or sends`);
        }
    });

    const published = new Set([...flow.owners.flatMap(o => o.commands.flatMap(c => c.events)), ...Object.values(flow.families).flat()]);
    handled.filter(h => !flow.families[h.name] && !published.has(h.name))
        .forEach(h => warnings.push(`${h.at}: ${h.group} handles ${h.name}, which no command in this file publishes (fine if it comes from outside the application)`));
    sent.filter(s => !commandOwner.has(s.name))
        .forEach(s => warnings.push(`${s.at}: ${s.group} sends ${s.name}, which no handler in this file handles`));
    reads.filter(r => !flow.groups.some(g => g.name === r.group))
        .forEach(r => errors.push(`${r.at}: ${r.query} reads ${r.group}, which is not a group in this file`));

    // Which group receives which event, and through which supertype if it handles one.
    flow.receives = new Map();
    flow.groups.forEach(g => g.handles.forEach(name => (flow.families[name] ?? [name]).forEach(event => {
        const key = `${g.name}|${event}`;
        if (!flow.receives.has(key) || flow.receives.get(key)) flow.receives.set(key, flow.families[name] ? name : null);
    })));
    flow.events = [...new Set([...published, ...[...flow.receives.keys()].map(k => k.split('|')[1])])];
    return { flow, errors, warnings };
}

/* ------------------------------------------------------------------ base/head model */

function union(head, base) {
    const out = [...head];
    base.forEach((item, i) => {
        if (out.includes(item)) return;
        const previous = base.slice(0, i).reverse().find(p => out.includes(p));
        out.splice(previous ? out.indexOf(previous) + 1 : 0, 0, item);
    });
    return out;
}
const status = (inBase, inHead) => inBase && inHead ? '' : inHead ? 'add' : inBase ? 'del' : '';
const byName = (list, name) => list.find(x => x.name === name);

// changed: commands whose fields or handling the change alters without rewiring them; a diff of the flows cannot see it.
function compare(B, H, changed = new Set()) {
    const groups = union(H.groups.map(g => g.name), B.groups.map(g => g.name)).map(name => {
        const hg = byName(H.groups, name), bg = byName(B.groups, name);
        return {
            name, medium: (hg ?? bg).medium, st: status(!!bg, !!hg),
            was: hg && bg && hg.medium !== bg.medium ? bg.medium : null,
            sends: union(hg?.sends ?? [], bg?.sends ?? []).map(c => ({ name: c, st: status(!!bg?.sends.includes(c), !!hg?.sends.includes(c)) })),
        };
    });
    const G = Object.fromEntries(groups.map(g => [g.name, g]));
    const events = {};
    union(H.events, B.events).forEach(e => { events[e] = { name: e, st: status(B.events.includes(e), H.events.includes(e)), consumers: [] }; });
    groups.forEach(g => Object.keys(events).forEach(e => {
        const key = `${g.name}|${e}`, inBase = B.receives.has(key), inHead = H.receives.has(key);
        if (inBase || inHead) events[e].consumers.push({ g, event: e, st: status(inBase, inHead), via: H.receives.get(key) ?? B.receives.get(key) ?? null });
    }));
    Object.values(events).forEach(e => e.consumers.sort((a, b) => media(a.g.medium).tier - media(b.g.medium).tier));

    const slices = [];
    union(H.owners.map(o => o.name), B.owners.map(o => o.name)).forEach(name => {
        const ho = byName(H.owners, name), bo = byName(B.owners, name);
        const owner = { name, st: status(!!bo, !!ho) };
        union((ho?.commands ?? []).map(c => c.name), (bo?.commands ?? []).map(c => c.name)).forEach(command => {
            const hc = byName(ho?.commands ?? [], command), bc = byName(bo?.commands ?? [], command);
            slices.push({
                cmd: command, owner, st: status(!!bc, !!hc), changed: !!hc && !!bc && changed.has(command),
                events: union(hc?.events ?? [], bc?.events ?? []).map(e => ({ name: e, link: status(!!bc?.events.includes(e), !!hc?.events.includes(e)) })),
            });
        });
    });
    const queries = [];
    union(H.queryOwners.map(o => o.name), B.queryOwners.map(o => o.name)).forEach(name => {
        const ho = byName(H.queryOwners, name), bo = byName(B.queryOwners, name);
        const owner = { name, st: status(!!bo, !!ho) };
        union((ho?.queries ?? []).map(q => q.name), (bo?.queries ?? []).map(q => q.name)).forEach(query => {
            const hq = byName(ho?.queries ?? [], query), bq = byName(bo?.queries ?? [], query);
            queries.push({
                query, owner, st: status(!!bq, !!hq),
                reads: union(hq?.reads ?? [], bq?.reads ?? []).map(g => ({ name: g, st: status(!!bq?.reads.includes(g), !!hq?.reads.includes(g)) })),
            });
        });
    });
    const sentBy = {};
    groups.forEach(g => g.sends.forEach(c => (sentBy[c.name] ??= []).push(g)));

    const M = { groups, G, events, slices, queries, sentBy };
    M.feeds = g => g ? Object.values(events).flatMap(e => e.consumers.filter(c => c.g === g)) : [];
    M.sliceChanged = (s, seen = new Set()) => {
        if (seen.has(s.cmd)) return false;
        seen.add(s.cmd);
        return !!(s.st || s.owner.st || s.events.some(e => e.link || events[e.name].st || events[e.name].consumers.some(c =>
            c.st || c.g.was || c.g.sends.some(x => x.st || slices.filter(t => t.cmd === x.name).some(t => M.sliceChanged(t, seen))))));
    };
    M.queryChanged = q => !!(q.st || q.owner.st || q.reads.some(r => r.st || G[r.name]?.was || M.feeds(G[r.name]).some(c => c.st)));
    return M;
}

/* ------------------------------------------------------------------ text measurement */

// Helvetica/Arial advance widths for ASCII 32..126, in 1/1000 em, regular and bold. The SVG asks for Helvetica or
// Arial (or a metric-compatible copy), and pins every text's length, so a different font cannot overflow a node.
const ADVANCE = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556,
    556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722,
    667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833,
    556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const ADVANCE_BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556,
    556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722,
    667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889,
    611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];
const STYLE = {
    name: { size: 12.5, weight: 600 }, medium: { size: 11.5, weight: 500 }, via: { size: 11, weight: 400 },
    label: { size: 11, weight: 400 }, note: { size: 11.5, weight: 400 }, head: { size: 10.5, weight: 700, spacing: 0.08 },
    key: { size: 11.5, weight: 400 }, flag: { size: 11, weight: 600 }, tiny: { size: 9.5, weight: 400 },
};
function measure(text, style) {
    const { size, weight, spacing = 0 } = STYLE[style];
    const table = weight >= 600 ? ADVANCE_BOLD : ADVANCE;
    let units = 0;
    for (const ch of text) {
        const code = ch.codePointAt(0);
        units += code >= 32 && code <= 126 ? table[code - 32] : 1000;
    }
    return units / 1000 * size + text.length * size * spacing;
}
const xml = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// A run of styled text: [[text, style, extraClass?], ...]
const runWidth = (run, gap = 0) => run.reduce((w, [t, s]) => w + measure(t, s), 0) + gap * Math.max(0, run.length - 1);
function runSvg(x, y, run, gap = 0) {
    let out = '', cx = x;
    run.forEach(([t, s, extra = '']) => {
        const w = measure(t, s);
        out += `<text x="${cx.toFixed(1)}" y="${y.toFixed(1)}" textLength="${w.toFixed(1)}" lengthAdjust="spacingAndGlyphs" class="${s} ${extra}">${xml(t)}</text>`;
        cx += w + gap;
    });
    return out;
}


/* ------------------------------------------------------------------ flows as data */

// Each flow as a tree of nodes. A node has a state for what happens to it in this flow: new, reuse (it existed and
// is unchanged, and this flow now reaches it), chg (its code or setup changes for this flow), del (it leaves this
// flow) or base (unchanged), and the facts of the change it shows. Facts have stable keys, so a fact shown in one diagram is not repeated in the next.
function trees(M) {
    const fact = (list, f) => list.push(f);
    const state = st => st === 'del' ? 'del' : st === 'add' ? 'new' : 'base';

    // reached: a new or reused node leads here, so an unchanged node here is reused by this flow.
    function slice(s, seen, top, sendSt = '', reached = false) {
        seen = new Set(seen).add(s.cmd);
        const facts = [];
        const live = s.events.filter(e => e.link !== 'del').map(e => e.name);
        if (s.st === 'add') fact(facts, { key: `cmd:${s.cmd}`, type: 'newcmd', cmd: s.cmd, owner: s.owner.name, ownerNew: s.owner.st === 'add', top, events: live });
        if (s.st === 'del') fact(facts, { key: `delcmd:${s.cmd}`, type: 'delcmd', cmd: s.cmd });
        // Only where a flow is drawn anyway (at the top, or newly reached), so every sender is not drawn for it.
        if (s.changed && (top || reached)) fact(facts, { key: `changed:${s.cmd}`, type: 'changedcmd', cmd: s.cmd, owner: s.owner.name });
        const events = s.events.map(e => {
            const own = [];
            if (s.st === '' && e.link === 'add') fact(own, { key: `publishes:${s.cmd}:${e.name}`, type: 'publishes', cmd: s.cmd, event: e.name });
            if (s.st === '' && e.link === 'del') fact(own, { key: `unpublishes:${s.cmd}:${e.name}`, type: 'unpublishes', cmd: s.cmd, event: e.name });
            // A removed command shows the reactions it takes with it; a dropped event, only itself.
            const gone = s.st === 'del' || e.link === 'del';
            const consumers = s.st === 'del' ? M.events[e.name].consumers.filter(c => c.st === 'del') : gone ? [] : M.events[e.name].consumers;
            const evSt = gone ? 'del' : M.events[e.name].st === 'add' ? 'new' : e.link === 'add' || reached || s.st === 'add' ? 'reuse' : 'base';
            return {
                kind: 'ev', name: e.name, facts: own, consumers: consumers.map(c => consumer(c, seen, !gone && evSt !== 'base')),
                st: evSt,
            };
        });
        const rewired = s.st !== '' || s.events.some(e => e.link !== '');
        return {
            kind: 'slice', cmd: s.cmd, facts, events,
            st: s.st === 'del' || sendSt === 'del' ? 'del' : s.st === 'add' ? 'new' : s.changed ? 'chg' : sendSt === 'add' || reached ? 'reuse' : 'base',
            owner: s.owner.name,
            ownerSt: s.owner.st === 'del' ? 'del' : s.owner.st === 'add' ? 'new' : rewired || s.changed ? 'chg' : reached ? 'reuse' : 'base',
        };
    }

    function consumer(c, seen, reached = false) {
        const g = c.g, facts = [];
        if (c.st === 'add') {
            if (g.st === 'add') fact(facts, { key: `group:${g.name}`, type: 'newgroup', g: g.name, medium: g.medium });
            fact(facts, { key: `receives:${g.name}:${c.event}`, type: c.via && g.st !== 'add' ? 'implicit' : 'receives', g: g.name, event: c.event, via: c.via });
        }
        if (c.st === 'del') fact(facts, { key: `unreceives:${g.name}:${c.event}`, type: 'unreceives', g: g.name, event: c.event });
        if (c.st !== 'del' && g.was) fact(facts, { key: `medium:${g.name}`, type: 'medium', g: g.name, from: g.was, to: g.medium });
        const grpSt = g.st === 'del' || c.st === 'del' ? 'del' : g.st === 'add' ? 'new'
            : g.was || g.sends.some(x => x.st) || (c.st === 'add' && !c.via) ? 'chg' : c.st === 'add' || reached ? 'reuse' : 'base';
        const sends = c.st === 'del' ? [] : g.sends.map(x => {
            const own = [];
            if (x.st === 'add') fact(own, { key: `sends:${g.name}:${x.name}`, type: 'sends', g: g.name, cmd: x.name });
            if (x.st === 'del') fact(own, { key: `unsends:${g.name}:${x.name}`, type: 'unsends', g: g.name, cmd: x.name });
            const handlers = x.st === 'del' ? [] : M.slices.filter(t => t.cmd === x.name && t.st !== 'del');
            const repeat = handlers.some(t => seen.has(t.cmd));
            return {
                kind: 'send', cmd: x.name, st: state(x.st), facts: own, unhandled: x.st !== 'del' && !handlers.length, repeat,
                slices: repeat ? [] : handlers.map(t => slice(t, seen, false, x.st, grpSt === 'new' || grpSt === 'reuse')),
            };
        });
        return {
            kind: 'grp', g, via: c.via, event: c.event, facts, sends,
            implicit: c.st === 'add' && !!c.via && g.st !== 'add', was: c.st !== 'del' ? g.was : null,
            st: grpSt,
        };
    }

    function query(q) {
        const facts = [];
        const live = q.reads.filter(r => r.st !== 'del').map(r => r.name);
        if (q.st === 'add') fact(facts, { key: `query:${q.query}`, type: 'newquery', q: q.query, owner: q.owner.name, ownerNew: q.owner.st === 'add', reads: live });
        if (q.st === 'del') fact(facts, { key: `delquery:${q.query}`, type: 'delquery', q: q.query });
        const reads = q.st === 'del' ? [] : q.reads.map(r => {
            const g = M.G[r.name], own = [];
            if (q.st === '' && r.st === 'add') fact(own, { key: `reads:${q.query}:${g.name}`, type: 'reads', q: q.query, g: g.name });
            if (q.st === '' && r.st === 'del') fact(own, { key: `unreads:${q.query}:${g.name}`, type: 'unreads', q: q.query, g: g.name });
            if (r.st !== 'del' && g.was) fact(own, { key: `medium:${g.name}`, type: 'medium', g: g.name, from: g.was, to: g.medium });
            const feeds = r.st === 'del' ? [] : M.feeds(g).map(c => {
                const ff = [];
                if (c.st === 'add') fact(ff, { key: `receives:${g.name}:${c.event}`, type: c.via && g.st !== 'add' ? 'implicit' : 'receives', g: g.name, event: c.event, via: c.via });
                if (c.st === 'del') fact(ff, { key: `unreceives:${g.name}:${c.event}`, type: 'unreceives', g: g.name, event: c.event });
                return { kind: 'feed', event: c.event, via: c.via, st: state(c.st), facts: ff };
            });
            const st = r.st === 'del' || g.st === 'del' ? 'del' : g.st === 'add' ? 'new' : g.was ? 'chg' : r.st === 'add' ? 'reuse' : 'base';
            return { kind: 'read', g, st, facts: own, feeds };
        });
        return { kind: 'query', q: q.query, owner: q.owner.name, ownerSt: state(q.owner.st), st: state(q.st), facts, reads };
    }

    const commands = M.slices.filter(s => !M.sentBy[s.cmd]).map(s => slice(s, new Set(), true));
    // A changed command that groups send gets a flow of its own, drawn unless a flow above already shows it.
    commands.push(...M.slices.filter(s => M.sentBy[s.cmd] && s.changed).map(s => slice(s, new Set(), true)));
    const queries = M.queries.map(query);
    return { commands, queries };
}

const CHILDREN = { slice: n => n.events, ev: n => n.consumers, grp: n => n.sends, send: n => n.slices, query: n => n.reads, read: n => n.feeds, feed: () => [] };
function factsOf(n) {
    if (!n._facts) {
        const all = [...n.facts, ...CHILDREN[n.kind](n).flatMap(factsOf)];
        n._facts = all.filter((f, i) => all.findIndex(o => o.key === f.key) === i);
    }
    return n._facts;
}

/* ------------------------------------------------------------------ layout blocks */

const H = 28, C = 14, LINK = 22;
const block = (w, h, draw, st = 'base') => ({ w, h, draw, st });
const edge = (x1, y1, x2, y2, cls = 'e') => `<path class="${cls}" d="M${x1.toFixed(1)} ${y1.toFixed(1)}L${x2.toFixed(1)} ${y2.toFixed(1)}"/>`;
const arrow = (x1, x2, y, st) => edge(x1, y, x2 - 2, y, `e ${st}`) + `<path class="ea ${st}" d="M${(x2 - 7).toFixed(1)} ${y - 4.5}L${x2.toFixed(1)} ${y}L${(x2 - 7).toFixed(1)} ${y + 4.5}z"/>`;
// A link has the colour of what it leads to; into a changed or unchanged node, the colour of where it comes from.
const linkState = (from, to) => to === 'del' || to === 'new' || to === 'reuse' ? to
    : from === 'del' || from === 'new' || from === 'reuse' ? from : 'base';
const RING = (cx, cy, r, w) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0zM${cx - r + w} ${cy}a${r - w} ${r - w} 0 1 1 ${2 * (r - w)} 0a${r - w} ${r - w} 0 1 1 ${-2 * (r - w)} 0z`;
// Flat rounded shapes: an arrow sends a request, an envelope is a message that tells what happened, a lens asks a
// question, a frame is the boundary that decides, and stacked bars are a group that takes events in turn.
const ICON = {
    cmd: (x, y) => `<rect class="i" x="${x}" y="${y + 4.4}" width="7.5" height="2.2" rx="1"/><path class="i" d="M${x + 5.5} ${y + 1}L${x + 11} ${y + 5.5}L${x + 5.5} ${y + 10}z"/>`,
    ev: (x, y) => `<path class="i" fill-rule="evenodd" d="M${x + 1.6} ${y + 1.2}h7.8a1.6 1.6 0 0 1 1.6 1.6v5.8a1.6 1.6 0 0 1-1.6 1.6h-7.8a1.6 1.6 0 0 1-1.6-1.6v-5.8a1.6 1.6 0 0 1 1.6-1.6zM${x + 1.9} ${y + 3.1}v5.4h7.2v-5.4l-3.6 2.9z"/>`,
    q: (x, y) => `<path class="i" fill-rule="evenodd" d="${RING(x + 4.6, y + 4.6, 4.4, 2)}"/><rect class="i" x="${x + 6.8}" y="${y + 7.9}" width="5" height="2.2" rx="1" transform="rotate(45 ${x + 7.6} ${y + 9})"/>`,
    own: (x, y) => `<path class="i" fill-rule="evenodd" d="M${x + 2} ${y}h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2zM${x + 2.2} ${y + 2.2}v6.6h6.6v-6.6z"/><rect class="i" x="${x + 3.9}" y="${y + 4.4}" width="3.2" height="2.2" rx="1"/>`,
    grp: (x, y) => [1, 4.75, 8.5].map(dy => `<rect class="i" x="${x}" y="${y + dy}" width="11" height="2.2" rx="1"/>`).join(''),
};
const KINDS = [['cmd', 'command'], ['ev', 'event'], ['q', 'query'], ['own', 'handler'], ['grp', 'processing group']];
const STATES = [['new', 'new'], ['chg', 'changed'], ['reuse', 'reused here'], ['del', 'removed here']];

// The key: what each icon means and, in a change, what each colour means.
function legend(states) {
    const items = [...KINDS.map(([kind, text]) => ({ text, draw: (x, y) => `<g class="s-base">${ICON[kind](x, y - 9.5)}</g>` })),
        ...STATES.filter(([st]) => states.includes(st)).map(([st, text], i) => ({ text, gap: i ? 0 : 14, draw: (x, y) =>
            `<g class="s-${st}"><rect class="k" x="${x}" y="${y - 10.5}" width="12" height="12" rx="3"/></g>` }))];
    const w = items.reduce((sum, i) => sum + (i.gap ?? 0) + 17 + measure(i.text, 'key') + 14, 0) - 14;
    return block(w, 14, (x, y) => items.reduce(([out, cx], i) => {
        cx += i.gap ?? 0;
        return [out + i.draw(cx, y + 12) + runSvg(cx + 17, y + 12, [[i.text, 'key']]), cx + 17 + measure(i.text, 'key') + 14];
    }, ['', x])[0]);
}

// A node: kind is cmd | ev | q | own | grp, told apart by its icon; st is new | chg | del | base, told by its colour.
function node(kind, run, st = 'base', minW = 0) {
    const icon = ICON[kind] ? 17 : 0;
    const textW = runWidth(run, 5), w = Math.max(20 + icon + textW, minW);
    return block(w, H, (x, y) => {
        let out = `<g class="s-${st}"><rect class="k k-${kind}" x="${x}" y="${y}" width="${w}" height="${H}" rx="${kind === 'own' ? 14 : 7}"/>`;
        if (icon) out += ICON[kind](x + 10, y + 8.5);
        out += runSvg(x + 10 + icon, y + 18.5, run, 5);
        return out + '</g>';
    }, st);
}
const groupNode = (run, st) => node('grp', run, st);
const nodeWidth = (kind, text) => 20 + (ICON[kind] ? 17 : 0) + runWidth([[text, 'name']], 5);
const label = (text, style = 'label', extra = '') => block(measure(text, style) + 10, H, (x, y) => runSvg(x + 6, y + 18, [[text, style, extra]]), 'base');
const note = text => label(text, 'note', 'faint');

const ARROW = { link: 'arrow' }, LINE = { link: 'line' };
// A link that says, in a word or two above it, what it means.
const arrowSays = text => ({ link: 'arrow', text }), lineSays = text => ({ link: 'line', text });
const linkWidth = text => text ? Math.max(LINK, measure(text, 'tiny') + 16) : LINK;
const linkLabel = (text, x, w, y) => text ? runSvg(x + (w - measure(text, 'tiny')) / 2, y + C - 5, [[text, 'tiny']]) : '';
const SAYS = { handled: 'handled by', publishes: 'publishes', delivered: 'delivered to', sends: 'sends', reads: 'reads', updated: 'updated by' };
function row(items) {
    const w = items.reduce((sum, i) => sum + (i.link ? linkWidth(i.text) : i.w), 0);
    const h = Math.max(H, ...items.filter(i => !i.link).map(i => i.h));
    const first = items.find(i => !i.link);
    return block(w, h, (x, y) => {
        let out = '', cx = x;
        items.forEach((i, k) => {
            if (i.link) {
                const before = items.slice(0, k).reverse().find(o => !o.link) ?? first;
                const after = items.slice(k + 1).find(o => !o.link);
                const st = linkState(before.st, after.st);
                const lw = linkWidth(i.text);
                out += i.link === 'arrow' ? arrow(cx, cx + lw, y + C, st) : edge(cx, y + C, cx + lw, y + C, `e ${st}`);
                out += linkLabel(i.text, cx, lw, y);
                cx += lw;
            } else {
                out += i.draw(cx, y);
                cx += i.w;
            }
        });
        return out;
    }, first.st);
}
const anyOn = items => items.some(i => i.st === 'new') ? 'new' : items.length && items.every(i => i.st === 'del') ? 'del' : 'base';

function stack(items, gap) {
    const w = Math.max(0, ...items.map(i => i.w));
    const h = items.reduce((sum, i) => sum + i.h, 0) + gap * Math.max(0, items.length - 1);
    return block(w, h, (x, y) => items.reduce(([out, cy], i) => [out + i.draw(x, cy), cy + i.h + gap], ['', y])[0], anyOn(items));
}

// from: the state of the node the tree hangs off, for the colour of each link.
function tree(items, gap = 8, from = 'base', arrows = true) {
    const inner = stack(items, gap);
    const links = items.map(i => linkState(from, i.st));
    return block(20 + inner.w, inner.h, (x, y) => {
        let out = '', cy = y;
        const ys = items.map(i => { const top = cy; cy += i.h + gap; return top + C; });
        // The spine down to each branch has that branch's colour; nearer branches are drawn over farther ones.
        for (let k = items.length - 1; k > 0; k--) out += edge(x, ys[0], x, ys[k], `e ${links[k]}`);
        items.forEach((i, k) => { out += arrows ? arrow(x, x + 20, ys[k], links[k]) : edge(x, ys[k], x + 18, ys[k], `e ${links[k]}`); });
        return out + inner.draw(x + 20, y);
    }, items[0]?.st ?? 'base');
}

// A processing group with the flows of the commands it sends below it, each on a link from the group like any other,
// then short notes.
function withSends(head, nests, notes = []) {
    if (!nests.length && !notes.length) return head;
    const SX = 15, NX = SX + linkWidth(SAYS.sends);
    const w = Math.max(head.w, NX + Math.max(0, ...nests.map(n => n.w)), SX + 8 + Math.max(0, ...notes.map(n => n.w)));
    const h = head.h + nests.reduce((sum, n) => sum + 10 + n.h, 0) + notes.length * 22;
    return block(w, h, (x, y) => {
        let out = head.draw(x, y), ny = y + head.h + 10;
        const ends = nests.map(n => { const end = ny + C; ny += n.h + 10; return end; });
        for (let k = nests.length - 1; k >= 0; k--) out += edge(x + SX, y + head.h, x + SX, ends[k], `e ${linkState(head.st, nests[k].st)}`);
        nests.forEach((n, k) => {
            out += arrow(x + SX, x + NX, ends[k], linkState(head.st, n.st)) + linkLabel(SAYS.sends, x + SX, NX - SX, ends[k] - C);
            out += n.draw(x + NX, ends[k] - C);
        });
        notes.forEach(n => { out += n.draw(x + SX + 2, ny - 6); ny += 22; });
        return out;
    }, head.st);
}

/* ------------------------------------------------------------------ drawing the trees */

// covered: keys of facts an earlier flow already shows. Unchanged branches fold away; branches whose changes were
// shown before are cut short with "shown above".
// cols: widths of the command, handler and event columns, shared by every flow of one image.
function layout(covered = new Set(), cols = {}) {
    const paint = st => st;
    const has = n => factsOf(n).length > 0;
    const open = n => factsOf(n).some(f => !covered.has(f.key));
    const names = (xs, kind) => list(xs.map(x => show(x, kind)));

    const groupRun = (g, n = {}) => [[g.name, 'name'], [media(g.medium).label, 'medium'],
        ...(n.via ? [[`via ${n.via}`, 'via']] : []),
        ...(n.was ? [[`was ${media(n.was).label}`, 'flag']] : []),
];

    function slice(s, nested = false) {
        const w = kind => nested ? 0 : cols[kind] ?? 0;
        const events = s.events.map(e => {
            const ev = node('ev', [[show(e.name, 'ev'), 'name']], paint(e.st), w('ev'));
            const st = paint(e.st);
            if (e.st === 'del') return e.consumers.length ? row([ev, lineSays(SAYS.delivered), consumers(e.consumers, st)]) : ev;
            // A flow that now reaches an event shows what it sets off, even where nothing there changed.
            if (!open(e) && st === 'base' && s.st !== 'chg') return has(e) && e.consumers.length ? row([ev, note('shown above')]) : ev;
            if (!e.consumers.length) return ev;
            return row([ev, lineSays(SAYS.delivered), consumers(e.consumers, st)]);
        });
        const own = paint(s.ownerSt);
        return row([
            node('cmd', [[show(s.cmd, 'cmd'), 'name']], paint(s.st), w('cmd')), arrowSays(SAYS.handled),
            node('own', [[s.owner, 'name']], own, w('own')),
            ...(events.length ? [lineSays(SAYS.publishes), tree(events, 12, own)] : []),
        ]);
    }

    // A group that starts flows of its own comes last, so its link to them has nothing to pass behind.
    const startsFlows = c => c.st !== 'del' && c.sends.some(x => x.st !== 'del' && !x.unhandled && !x.repeat && (open(x) || c.st === 'new' || c.st === 'reuse'));

    function consumers(cs, from) {
        const shown = [], quiet = [];
        cs.forEach(c => (c.st === 'base' && !has(c) ? quiet : shown).push(c));
        const items = shown.filter(c => !startsFlows(c)).map(group);
        if (quiet.length > 2) items.push(node('grp', [[`${quiet.length} other groups`, 'name']], 'base'));
        else items.push(...quiet.map(c => groupNode(groupRun(c.g, c), 'base')));
        items.push(...shown.filter(startsFlows).map(group));
        return tree(items, 8, from);
    }

    function group(c) {
        const plain = groupNode(groupRun(c.g, c), paint(c.st));
        if (c.st === 'del') return plain;
        // Where the group is drawn, so the flows it starts can link back to it.
        const at = {};
        const head = { ...plain, draw: (x, y) => { Object.assign(at, { x, y, h: plain.h }); return plain.draw(x, y); } };
        // A group this flow newly reaches shows what its commands set off; elsewhere an unchanged send is just its command.
        const reached = c.st === 'new' || c.st === 'reuse';
        const nests = c.sends.map(x => {
            const cmd = node('cmd', [[show(x.cmd, 'cmd'), 'name']], paint(x.st));
            if (x.st === 'del') return cmd;
            if (x.unhandled) return row([cmd, note('not handled in this application')]);
            if (x.repeat) return row([cmd, note('shown above')]);
            // A sent command starts a flow of its own, drawn below from the command column, on a link from this group.
            if (open(x) || reached) {
                x.slices.forEach(s => later.push({ s, from: at, fromSt: paint(c.st) }));
                return null;
            }
            return has(x) ? row([cmd, note('shown above')]) : cmd;
        }).filter(Boolean);
        return withSends(head, nests);
    }

    function query(q) {
        const reads = q.reads.map(r => {
            const head = groupNode(groupRun(r.g, { was: r.g.was }), paint(r.st));
            if (r.st === 'del') return head;
            const live = r.feeds.filter(f => f.st !== 'del');
            const families = [...new Set(live.filter(f => f.via).map(f => f.via))].map(family => {
                const members = live.filter(f => f.via === family);
                return { st: anyOn(members.map(m => ({ st: m.st }))), facts: members.flatMap(m => m.facts), run: [[`all ${family}`, 'name'], [String(members.length), 'via']] };
            });
            const items = [...families, ...r.feeds.filter(f => !f.via).map(f => ({ st: f.st, facts: f.facts, run: [[show(f.event, 'ev'), 'name']] }))];
            let fed = items.map(i => ({ ...i, block: node('ev', i.run, paint(i.st)) }));
            const quiet = fed.filter(i => i.st === 'base' && !i.facts.length);
            if (quiet.length > 3) fed = [...fed.filter(i => !quiet.includes(i)), { block: node('ev', [[`${quiet.length} other events`, 'name']], 'base') }];
            if (!fed.length) return head;
            return row([head, lineSays(SAYS.updated), tree(fed.map(i => i.block))]);
        });
        return row([
            node('q', [[show(q.q, 'q'), 'name']], paint(q.st)), arrowSays(SAYS.handled),
            node('own', [[q.owner, 'name']], paint(q.ownerSt)),
            ...(reads.length ? [lineSays(SAYS.reads), tree(reads)] : []),
        ]);
    }

    // Flows that groups start by sending a command, drawn under the flow that sends them. A link runs from the group
    // down into the gap above them, left to a lane in the margin, and into each command, behind any box it passes.
    let later = [];
    return n => {
        if (n.kind !== 'slice') return query(n);
        later = [];
        const rows = [{ flow: slice(n) }];
        while (later.length) { const { s, from, fromSt } = later.shift(); const flow = slice(s); rows.push({ flow, from, st: linkState(fromSt, flow.st) }); }
        if (rows.length === 1) return rows[0].flow;
        const GAP = 26, LANE = 12;
        const w = Math.max(...rows.map(r => r.flow.w)), h = rows.reduce((sum, r) => sum + r.flow.h, 0) + GAP * (rows.length - 1);
        return block(w, h, (x, y) => {
            let body = '', links = '', cy = y;
            const tops = rows.map(r => { const top = cy; body += r.flow.draw(x, cy); cy += r.flow.h + GAP; return top; });
            const senders = new Map();
            rows.forEach((r, i) => { if (r.from) senders.set(r.from, [...(senders.get(r.from) ?? []), i]); });
            senders.forEach((targets, at) => {
                const sx = at.x + 15, gy = tops[targets[0]] - GAP / 2, lane = x - LANE, first = rows[targets[0]].st;
                links += edge(sx, at.y + at.h, sx, gy, `e ${first}`) + edge(sx, gy, lane, gy, `e ${first}`);
                links += runSvg(sx - measure(SAYS.sends, 'tiny') - 6, gy - 4, [[SAYS.sends, 'tiny']]);
                for (let k = targets.length - 1; k >= 0; k--) {
                    const end = tops[targets[k]] + C, st = rows[targets[k]].st;
                    links += edge(lane, gy, lane, end, `e ${st}`) + arrow(lane, x, end, st);
                }
            });
            return links + body;
        }, rows[0].flow.st);
    };
}

/* ------------------------------------------------------------------ describing a change */

const list = items => items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
const b = s => `**${s}**`;
const evs = es => list(es.map(e => b(show(e, 'ev'))));
const cmds = cs => list(cs.map(c => b(show(c, 'cmd'))));

// One or a few plain sentences for the facts a diagram shows first. The agent rewrites them; they are the fallback.
function describe(facts, M) {
    const sentences = [], folded = new Set();
    const keys = new Set(facts.map(f => f.key));
    const handlers = e => M.events[e].consumers.filter(c => c.st !== 'del').map(c => c.g.name);

    facts.filter(f => f.type === 'newcmd' && f.top).forEach(f => {
        let s = `New command ${cmds([f.cmd])}, handled by ${f.ownerNew ? 'the new ' : ''}${b(f.owner)}, publishes `;
        if (!f.events.length) s += 'no events';
        else {
            s += evs(f.events);
            if (f.events.length === 1) {
                const e = f.events[0], groups = handlers(e);
                const simple = facts.filter(x => x.type === 'receives' && x.event === e && !keys.has(`group:${x.g}`) && !keys.has(`medium:${x.g}`));
                if (!groups.length) s += ', which no processing group handles';
                else if (simple.length === groups.length) {
                    simple.forEach(x => folded.add(x.key));
                    s += `, which ${list(groups.map(b))} handle${groups.length === 1 ? 's' : ''}`;
                }
            }
        }
        sentences.push(s + '.');
    });
    facts.filter(f => f.type === 'delcmd').forEach(f => sentences.push(`Command ${cmds([f.cmd])} was removed.`));
    const altered = facts.filter(f => f.type === 'changedcmd');
    if (altered.length) {
        const one = altered.length === 1, owners = [...new Set(altered.map(f => f.owner))];
        sentences.push(`${cmds(altered.map(f => f.cmd))} change${one ? 's' : ''}: ${one ? 'its' : 'their'} fields or how ${list(owners.map(b))} handle${owners.length === 1 ? 's' : ''} ${one ? 'it' : 'them'}.`);
    }

    // New processing groups, then one sentence per kind of change, naming every group it applies to.
    const fresh = new Map();
    facts.filter(f => f.type === 'newgroup').forEach(f => fresh.set(f.g, { medium: f.medium, handles: [], sends: [] }));
    const clauses = [];
    const clause = (g, type, item, extra = '') => {
        const id = `${type}|${extra}`;
        let perGroup = clauses.find(c => c.g === g && c.id === id);
        if (!perGroup) clauses.push(perGroup = { g, id, type, extra, items: [] });
        if (item && !perGroup.items.includes(item)) perGroup.items.push(item);
    };
    facts.forEach(f => {
        if (folded.has(f.key)) return;
        if (f.type === 'receives' && fresh.has(f.g)) fresh.get(f.g).handles.push(f);
        else if (f.type === 'sends' && fresh.has(f.g)) fresh.get(f.g).sends.push(f.cmd);
        else if (f.type === 'receives' || f.type === 'unreceives') clause(f.g, f.type, f.event);
        else if (f.type === 'implicit') clause(f.g, f.type, f.event, f.via);
        else if (f.type === 'medium') clause(f.g, f.type, null, `${f.from}>${f.to}`);
        else if (f.type === 'sends' || f.type === 'unsends') clause(f.g, f.type, f.cmd);
    });
    fresh.forEach((g, name) => {
        const vias = [...new Set(g.handles.map(f => f.via ?? ''))];
        const handles = list(vias.map(via => `${evs(g.handles.filter(f => (f.via ?? '') === via).map(f => f.event))}${via ? ` through \`${via}\`` : ''}`));
        sentences.push(`New processing group ${b(name)} (*${media(g.medium).label}*) handles ${handles}${g.sends.length ? ` and sends ${cmds(g.sends)}` : ''}.`);
    });
    const merged = [];
    clauses.forEach(c => {
        const same = merged.find(m => m.id === c.id && m.items.join() === c.items.join());
        if (same) same.groups.push(c.g); else merged.push({ ...c, groups: [c.g] });
    });
    merged.forEach(m => {
        const one = m.groups.length === 1, s = one ? 's' : '', who = list(m.groups.map(b));
        const [from, to] = m.extra.split('>');
        sentences.push({
            receives: `${who} now handle${s} ${evs(m.items)}.`,
            unreceives: `${who} no longer handle${s} ${evs(m.items)}.`,
            implicit: `${who} now receive${s} ${evs(m.items)} through \`${m.extra}\`, without a code change.`,
            medium: `${who} moved from *${media(from).label}* to *${media(to).label}*: ${one ? 'it' : 'they'} ${media(to).says.replace(/^is /, one ? 'is ' : 'are ').replace(/^runs /, one ? 'runs ' : 'run ')}.`,
            sends: `${who} now send${s} ${cmds(m.items)}.`,
            unsends: `${who} no longer send${s} ${cmds(m.items)}.`,
        }[m.type]);
    });

    const byCommand = type => [...new Set(facts.filter(f => f.type === type).map(f => f.cmd))]
        .map(cmd => [cmd, facts.filter(f => f.type === type && f.cmd === cmd).map(f => f.event)]);
    byCommand('publishes').forEach(([cmd, es]) => sentences.push(`${cmds([cmd])} now publishes ${evs(es)}.`));
    byCommand('unpublishes').forEach(([cmd, es]) => sentences.push(`${cmds([cmd])} no longer publishes ${evs(es)}.`));
    facts.filter(f => f.type === 'newcmd' && !f.top).forEach(f => {
        const lonely = f.events.filter(e => !handlers(e).length);
        if (!f.ownerNew && !lonely.length) return;
        sentences.push(`${cmds([f.cmd])} is handled by ${f.ownerNew ? 'the new ' : ''}${b(f.owner)}${lonely.length ? `; ${evs(lonely)} ${lonely.length === 1 ? 'is' : 'are'} handled by no processing group` : ''}.`);
    });

    facts.filter(f => f.type === 'newquery').forEach(f => sentences.push(
        `New query ${b(show(f.q, 'q'))}, handled by ${f.ownerNew ? 'the new ' : ''}${b(f.owner)}, reads ${f.reads.length ? list(f.reads.map(b)) : 'no processing group'}.`));
    facts.filter(f => f.type === 'reads').forEach(f => sentences.push(`${b(show(f.q, 'q'))} now reads ${b(f.g)}.`));
    facts.filter(f => f.type === 'unreads').forEach(f => sentences.push(`${b(show(f.q, 'q'))} no longer reads ${b(f.g)}.`));
    facts.filter(f => f.type === 'delquery').forEach(f => sentences.push(`Query ${b(show(f.q, 'q'))} was removed.`));
    return sentences.join(' ');
}

/* ------------------------------------------------------------------ pages */

// Colour tells what the change does to a node in that flow: green new, amber changed, blue reused here (it exists, is
// untouched, and the flow now reaches it), red removed here (deleted, or the flow no longer reaches it). Grey is untouched.
const LIGHT = 'svg{--bg:#f6f5f1;--fg:#1c1c1e;--muted:#6f6f78;--faint:#a3a3ab;--line:#e4e2db;--card:#fff;--edge:#c9c6bd;--node:#efeee9;--node-fg:#3f3f46;--node-sub:#85858e;--icon:#8f8e88;--new:#15803d;--new-bg:#dcfce7;--new-fg:#14532d;--chg:#b45309;--chg-bg:#fef3c7;--chg-fg:#78350f;--del:#b91c1c;--del-bg:#fee2e2;--del-fg:#7f1d1d;--reu:#1d4ed8;--reu-bg:#dbeafe;--reu-fg:#1e3a8a}';
const DARK = 'svg{--bg:#121214;--fg:#ececef;--muted:#a1a1aa;--faint:#6b6b74;--line:#2a2a30;--card:#1a1a1e;--edge:#46464e;--node:#232327;--node-fg:#d4d4d8;--node-sub:#8b8b94;--icon:#6b6b74;--new:#4ade80;--new-bg:#12341f;--new-fg:#bbf7d0;--chg:#fbbf24;--chg-bg:#3a2c0f;--chg-fg:#fde68a;--del:#f87171;--del-bg:#3b1515;--del-fg:#fecaca;--reu:#60a5fa;--reu-bg:#132a4a;--reu-fg:#bfdbfe}';
const STYLES = `<style>
%PALETTE%
text{font-family:Helvetica,Arial,"Liberation Sans",Arimo,sans-serif;fill:var(--fg)}
.bg{fill:var(--bg)}
.e{stroke:var(--edge);stroke-width:1.5;fill:none}.e.new{stroke:var(--new)}.e.del{stroke:var(--del)}.e.reuse{stroke:var(--reu)}.e.chg{stroke:var(--chg)}
.ea{fill:var(--edge)}.ea.new{fill:var(--new)}.ea.del{fill:var(--del)}.ea.reuse{fill:var(--reu)}.ea.chg{fill:var(--chg)}
.name{font-size:12.5px;font-weight:600}.medium{font-size:11.5px;font-weight:500}.via,.label{font-size:11px;fill:var(--muted)}
.note{font-size:11.5px;font-style:italic}.faint{fill:var(--faint)}.flag{font-size:11px;font-weight:600}
.key{font-size:11.5px;fill:var(--muted)}
.k{fill:var(--node);stroke:var(--line);stroke-width:1}.i{fill:var(--icon)}.s-base text{fill:var(--node-fg)}.s-base .medium,.s-base .via{fill:var(--node-sub)}
.s-new .k{fill:var(--new-bg);stroke:var(--new);stroke-width:1.4}.s-new .i{fill:var(--new)}.s-new text{fill:var(--new-fg)}.s-new .medium,.s-new .via,.s-new .flag{fill:var(--new)}
.s-chg .k{fill:var(--chg-bg);stroke:var(--chg);stroke-width:1.4}.s-chg .i{fill:var(--chg)}.s-chg text{fill:var(--chg-fg)}.s-chg .medium,.s-chg .via,.s-chg .flag{fill:var(--chg)}
.s-del .k{fill:var(--del-bg);stroke:var(--del);stroke-width:1.4}.s-del .i{fill:var(--del)}.s-del text{fill:var(--del-fg)}.s-del .medium,.s-del .via,.s-del .flag{fill:var(--del)}
.s-reuse .k{fill:var(--reu-bg);stroke:var(--reu);stroke-width:1.4}.s-reuse .i{fill:var(--reu)}.s-reuse text{fill:var(--reu-fg)}.s-reuse .medium,.s-reuse .via,.s-reuse .flag{fill:var(--reu)}
.rule{stroke:var(--line);stroke-width:1}.tiny{font-size:9.5px;fill:var(--muted)}.head{font-size:10.5px;font-weight:700;letter-spacing:.08em;fill:var(--muted)}
</style>`;

// One image per theme: an SVG in an <img> cannot follow the page's theme, so a <picture> picks the light or dark file.
const themed = (svg, palette) => svg.replace('%PALETTE%', palette);

function page(width, height, ariaLabel, body) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(width)}" height="${Math.ceil(height)}" viewBox="0 0 ${Math.ceil(width)} ${Math.ceil(height)}" role="img" aria-label="${xml(ariaLabel)}">
${STYLES}
<rect class="bg" width="100%" height="100%"/>
${body}
</svg>
`;
}

// The widths of the command, handler and event columns over the top-level flows of one image.
function columns(members) {
    const sent = s => s.events.flatMap(e => e.consumers.flatMap(c => c.sends.flatMap(x => x.slices)));
    const all = xs => xs.flatMap(s => [s, ...all(sent(s))]);
    const slices = all(members.filter(m => m.kind === 'slice'));
    const max = xs => Math.max(0, ...xs);
    return {
        cmd: max(slices.map(s => nodeWidth('cmd', show(s.cmd, 'cmd')))),
        own: max(slices.map(s => nodeWidth('own', s.owner))),
        ev: max(slices.flatMap(s => s.events.map(e => nodeWidth('ev', show(e.name, 'ev'))))),
    };
}

// Above flows that share columns: what each column holds, so the eye reads them as one table.
function columnHeads(cols) {
    const own = cols.cmd + linkWidth(SAYS.handled), ev = own + cols.own + linkWidth(SAYS.publishes) + 20;
    const heads = [['COMMAND', 0], ['HANDLER', own], ['EVENT', ev], ['PROCESSING GROUPS', ev + cols.ev + linkWidth(SAYS.delivered) + 20]];
    return block(heads.at(-1)[1] + 120, 16, (x, y) => heads.map(([text, dx]) => runSvg(x + dx + 2, y + 11, [[text, 'head']])).join(''));
}

// Every flow the change touches, in one image under one key, with its columns lined up across flows.
function drawChange(M, title) {
    const { commands, queries } = trees(M);
    const diagrams = [], covered = new Set();
    [...commands, ...queries].forEach(n => {
        const facts = factsOf(n);
        if (!facts.length) return;
        const fresh = facts.filter(f => !covered.has(f.key));
        if (!fresh.length) {
            const same = diagrams.find(d => d.facts.length === facts.length && facts.every(f => d.facts.some(o => o.key === f.key)));
            if (same) same.members.push(n);
            return;
        }
        diagrams.push({ members: [n], facts, fresh, covered: new Set(covered) });
        facts.forEach(f => covered.add(f.key));
    });

    if (!diagrams.length) return null;
    const MARGIN = 20, GAP = 30;
    {
        const ds = diagrams;
        const d = { members: ds.flatMap(x => x.members), fresh: ds.flatMap(x => x.fresh) };
        const cols = columns(d.members);
        const drawn = ds.flatMap(x => x.members.map(n => layout(x.covered, cols)(n)));
        const heads = drawn.length > 1 && d.members.every(m => m.kind === 'slice') ? [columnHeads(cols)] : [];
        const parts = [...heads, ...drawn];
        const flows = block(Math.max(...parts.map(p => p.w)), parts.reduce((h, p) => h + p.h, 0) + GAP * (parts.length - 1) - (heads.length ? GAP - 14 : 0), (x, y) => {
            let out = '', cy = y;
            parts.forEach((p, k) => {
                if (k > heads.length) out += `<path class="rule" d="M${x} ${(cy - GAP / 2).toFixed(1)}H${x + Math.max(...parts.map(q => q.w))}"/>`;
                out += p.draw(x, cy);
                cy += p.h + (k === heads.length - 1 ? 14 : GAP);
            });
            return out;
        });
        flows.drawn = flows.draw(MARGIN, MARGIN);
        flows.svgStates = new Set([...flows.drawn.matchAll(/class="s-(\w+)"/g)].map(m => m[1]));
        const key = legend(STATES.map(([st]) => st).filter(st => flows.svgStates.has(st)));
        const width = Math.max(flows.w, key.w) + MARGIN * 2;
        const height = MARGIN + flows.h + 22 + key.h + MARGIN;
        const body = flows.drawn + key.draw(MARGIN, MARGIN + flows.h + 22);
        const names = d.members.map(m => m.kind === 'slice' ? show(m.cmd, 'cmd') : show(m.q, 'q'));
        return { svg: page(width, height, `${title}: SMD flow of ${list(names)}`, body), text: describe(d.fresh, M), names };
    }
}

function markdown(change, light, dark) {
    if (!change) return 'This change leaves the SMD flows as they were: no command, event, processing group, medium or query was added, removed or rewired.\n';
    return `${change.text}\n\n<picture><source media="(prefers-color-scheme: dark)" srcset="${dark}"><img src="${light}" alt="SMD flow of ${xml(list(change.names))}"></picture>\n`;
}

/* ------------------------------------------------------------------ command line */

function fail(message) {
    console.error(message);
    process.exit(2);
}

const options = { head: null, base: null, out: 'smd-flow', changed: [] };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => (i + 1 < argv.length ? argv[++i] : fail(`${arg} needs a value\n${USAGE}`));
    if (arg === '--base') options.base = value();
    else if (arg === '--out' || arg === '-o') options.out = value().replace(/\.svg$/, '');
    else if (arg === '--changed') options.changed.push(...value().split(',').map(s => s.trim()).filter(Boolean));
    else if (arg === '--help' || arg === '-h') { console.log(USAGE); process.exit(0); }
    else if (arg.startsWith('-')) fail(`unknown option ${arg}\n${USAGE}`);
    else if (!options.head) options.head = arg;
    else fail(`unexpected argument ${arg}\n${USAGE}`);
}
if (!options.head || !options.base) fail(USAGE);

const read = path => { try { return readFileSync(path, 'utf8'); } catch (error) { return fail(`cannot read ${path}: ${error.message}`); } };
const parsed = [[options.head, read(options.head)], [options.base, read(options.base)]].map(([path, source]) => parse(source, path));
let errorCount = 0;
parsed.forEach(({ errors, warnings }) => {
    warnings.forEach(message => console.error(`warning: ${message}`));
    errors.forEach(message => console.error(`error: ${message}`));
    errorCount += errors.length;
});
if (errorCount) fail(`${errorCount} error(s); nothing rendered`);
const head = parsed[0].flow, base = parsed[1].flow;
const known = new Set(head.owners.flatMap(o => o.commands.map(c => c.name)));
options.changed.filter(c => !known.has(c)).forEach(c => fail(`--changed ${c}: no such command in ${options.head}`));

const write = (path, content) => { writeFileSync(path, content); console.error(`wrote ${path}`); };
const change = drawChange(compare(base, head, new Set(options.changed)), head.title || basename(options.head).replace(/\.smdflow$/, ''));
if (change) {
    write(`${options.out}-light.svg`, themed(change.svg, LIGHT));
    write(`${options.out}-dark.svg`, themed(change.svg, DARK));
}
write(`${options.out}.md`, markdown(change, `${basename(options.out)}-light.svg`, `${basename(options.out)}-dark.svg`));
