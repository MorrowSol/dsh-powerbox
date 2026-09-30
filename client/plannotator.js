/* ===== dsh-powerbox · client/plannotator.js =====
 * 原 dsh-plannotator-embedded 客户端半区整体平移：
 * shell.overlay 评审面板（多计划芯片、批注、托盘、其他会话新计划通知弹条）。
 * 工具箱开关：宿主在 pending 应答里带 `enabled` 字段；关闭且没有任何
 * 在途/历史评审时整块不渲染（在途评审保留可继续决策）。
 * 由 scripts/build-client.mjs 拼接进 client.js，共享外层的 React / E / TK。
 */

	{
		function clampV(v, a, b) { return Math.max(a, Math.min(b, v)); }

		function firstHeading(md) {
			const lines = String(md || '').split('\n');
			for (const line of lines) {
				const m = /^#{1,6}\s+(.+?)\s*$/.exec(line);
				if (m) return m[1];
			}
			return '';
		}

		function inlineNodes(text, kb) {
			const nodes = [];
			const re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(~~[^~\n]+~~)|(\*[^*\n]+\*)|(_[^_\n]+_)|(\[([^\]\n]+)\]\(([^)\s]+)\))/g;
			let last = 0;
			let m;
			let k = 0;
			while ((m = re.exec(text)) !== null) {
				if (m.index > last) nodes.push(text.slice(last, m.index));
				const t = m[0];
				if (m[1] !== undefined) nodes.push(E('code', { className: 'pttr-code', key: kb + 'c' + k }, t.slice(1, -1)));
				else if (m[2] !== undefined || m[3] !== undefined) nodes.push(E('strong', { key: kb + 'b' + k }, t.slice(2, -2)));
				else if (m[4] !== undefined) nodes.push(E('del', { key: kb + 'd' + k }, t.slice(2, -2)));
				else if (m[5] !== undefined || m[6] !== undefined) nodes.push(E('em', { key: kb + 'e' + k }, t.slice(1, -1)));
				else if (m[7] !== undefined) nodes.push(E('a', { className: 'pttr-a', key: kb + 'a' + k, href: m[9], target: '_blank', rel: 'noreferrer' }, m[8]));
				k++;
				last = m.index + t.length;
			}
			if (last < text.length) nodes.push(text.slice(last));
			return nodes;
		}

		function parseBlocks(md) {
			const lines = String(md || '').split('\n');
			const blocks = [];
			let i = 0;
			const isList = /^\s*([-*+]|\d+[.)])\s+/;
			const isH = /^#{1,6}\s+/;
			const isQuote = /^\s*>/;
			const isFence = /^\s*(```|~~~)/;
			const isHr = /^\s*([-*_])\s*(\1\s*){2,}$/;
			const isTableSep = /^\s*\|?[\s:|-]+\|?\s*$/;
			while (i < lines.length) {
				const line = lines[i];
				const fence = /^\s*(```|~~~)\s*(\S*)\s*$/.exec(line);
				if (fence) {
					const markCh = fence[1][0];
					const buf = [];
					i++;
					while (i < lines.length) {
						const t = lines[i].trim();
						if (t[0] === markCh && /^[`~]{3,}\s*$/.test(t)) break;
						buf.push(lines[i]);
						i++;
					}
					i++;
					blocks.push({ type: 'code', lang: fence[2] || '', text: buf.join('\n') });
					continue;
				}
				const h = /^(#{1,6})\s+(.*)$/.exec(line);
				if (h) { blocks.push({ type: 'h', level: h[1].length, text: h[2] }); i++; continue; }
				if (isHr.test(line)) { blocks.push({ type: 'hr' }); i++; continue; }
				if (isQuote.test(line)) {
					const buf = [];
					while (i < lines.length && isQuote.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
					blocks.push({ type: 'quote', text: buf.join('\n') });
					continue;
				}
				if (line.indexOf('|') >= 0 && i + 1 < lines.length && isTableSep.test(lines[i + 1]) && lines[i + 1].indexOf('-') >= 0) {
					const parseRow = function (l) { return l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(function (c) { return c.trim(); }); };
					const rows = [parseRow(line)];
					i += 2;
					while (i < lines.length && lines[i].indexOf('|') >= 0) { rows.push(parseRow(lines[i])); i++; }
					blocks.push({ type: 'table', rows: rows });
					continue;
				}
				if (isList.test(line)) {
					const ordered = /\d/.test(line.trim()[0]);
					const items = [];
					while (i < lines.length && isList.test(lines[i])) {
						const m2 = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
						items.push(m2[2]);
						i++;
						while (i < lines.length && lines[i].trim() !== '' && !isList.test(lines[i]) && !isH.test(lines[i]) && !isQuote.test(lines[i]) && !isFence.test(lines[i]) && !isHr.test(lines[i])) {
							items[items.length - 1] += ' ' + lines[i].trim();
							i++;
						}
					}
					blocks.push({ type: 'list', ordered: ordered, items: items });
					continue;
				}
				if (line.trim() === '') { i++; continue; }
				const buf = [line];
				i++;
				while (i < lines.length && lines[i].trim() !== '' && !isH.test(lines[i]) && !isQuote.test(lines[i]) && !isFence.test(lines[i]) && !isHr.test(lines[i]) && !isList.test(lines[i])) {
					buf.push(lines[i]);
					i++;
				}
				blocks.push({ type: 'p', text: buf.join('\n') });
			}
			return blocks;
		}

		function renderInlineMarked(text, quotes, kb) {
			if (!quotes.length) return inlineNodes(text, kb + 'p');
			let segments = [{ t: text, mark: false }];
			for (const q of quotes) {
				if (!q || q.length < 2) continue;
				const next = [];
				for (const seg of segments) {
					if (seg.mark) { next.push(seg); continue; }
					const idx = seg.t.indexOf(q);
					if (idx === -1) { next.push(seg); continue; }
					if (idx > 0) next.push({ t: seg.t.slice(0, idx), mark: false });
					next.push({ t: q, mark: true });
					if (idx + q.length < seg.t.length) next.push({ t: seg.t.slice(idx + q.length), mark: false });
				}
				segments = next;
			}
			const out = [];
			for (let i = 0; i < segments.length; i++) {
				const s = segments[i];
				if (s.mark) out.push(E('mark', { className: 'pttr-mark', key: kb + 'm' + i }, inlineNodes(s.t, kb + 'm' + i)));
				else out.push(E(React.Fragment, { key: kb + 's' + i }, inlineNodes(s.t, kb + 's' + i)));
			}
			return out;
		}

		function defaultGeo() {
			return { leftFull: null, leftDock: null, dockBottomH: 300, annSplit: 0.56, sideW: 360, sideSplit: 0.56 };
		}

		var CSS = `
.pttr-root { position: fixed; inset: 0; z-index: 1000; pointer-events: none; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif; font-size: 14px; color: var(--dsw-alias-label-primary, #1a1a1a); }
.pttr-root * { box-sizing: border-box; }
.pttr-panel { pointer-events: auto; position: fixed; top: 0; right: 0; bottom: 0; left: 0; display: flex; flex-direction: column; background: var(--dsw-alias-bg-base, #fff); }
.pttr-shadow { border-left: 1px solid var(--dsw-alias-border-l2, #ccc); box-shadow: -12px 0 32px rgba(0,0,0,.18); }
.pttr-dragstrip { position: absolute; left: 0; top: 0; bottom: 0; width: 8px; cursor: col-resize; z-index: 30; }
.pttr-dragstrip:hover { background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4b7bec) 30%, transparent); }
.pttr-split-v { flex: none; width: 7px; cursor: col-resize; z-index: 5; }
.pttr-split-h { flex: none; height: 7px; cursor: row-resize; z-index: 5; }
.pttr-split-v:hover, .pttr-split-h:hover { background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4b7bec) 35%, transparent); }
.pttr-head { display: flex; align-items: baseline; gap: 12px; padding: 10px 18px; border-bottom: 1px solid var(--dsw-alias-border-l1, #e5e5e5); background: var(--dsw-alias-bg-layer-1, #f7f7f8); flex: none; }
.pttr-title { font-weight: 650; font-size: 15px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 46%; }
.pttr-sub { color: var(--dsw-alias-label-secondary, #888); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.pttr-modes { display: flex; gap: 4px; flex: none; }
.pttr-modebtn { border: 1px solid var(--dsw-alias-border-l1, #e0e0e0); background: transparent; color: var(--dsw-alias-label-secondary, #666); border-radius: 6px; padding: 3px 9px; font-size: 12px; cursor: pointer; }
.pttr-modebtn.on { background: var(--dsw-alias-brand-primary, #4b7bec); border-color: var(--dsw-alias-brand-primary, #4b7bec); color: #fff; }
.pttr-banner { padding: 8px 18px; font-size: 13px; flex: none; border-bottom: 1px solid var(--dsw-alias-border-l1, #e5e5e5); }
.pttr-b-ok { background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #2e9e5b) 14%, transparent); color: var(--dsw-alias-state-success-primary, #2e9e5b); }
.pttr-b-back { background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4b7bec) 12%, transparent); color: var(--dsw-alias-brand-primary, #3b6bd6); }
.pttr-b-warn { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d69e2e) 14%, transparent); color: var(--dsw-alias-state-warn-primary, #a87b1a); }
.pttr-b-mute { background: var(--dsw-alias-bg-layer-1, #f5f5f5); color: var(--dsw-alias-label-secondary, #888); }
.pttr-body { display: flex; flex: 1; min-height: 0; }
.pttr-content { flex: 1; overflow: auto; padding: 26px 40px 80px; min-width: 0; }
.pttr-inner { max-width: 860px; margin: 0 auto; line-height: 1.7; font-size: 15px; }
.pttr-block { position: relative; padding: 1px 2px; border-radius: 4px; }
.pttr-block.pttr-ann { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d69e2e) 8%, transparent); box-shadow: inset 3px 0 0 var(--dsw-alias-state-warn-primary, #d69e2e); padding-left: 10px; }
.pttr-badge { position: absolute; left: -14px; top: 2px; min-width: 18px; height: 18px; border-radius: 9px; background: var(--dsw-alias-state-warn-primary, #d69e2e); color: #fff; font-size: 11px; line-height: 18px; text-align: center; padding: 0 4px; }
.pttr-inner h1, .pttr-inner h2, .pttr-inner h3, .pttr-inner h4, .pttr-inner h5, .pttr-inner h6 { margin: 1.2em 0 .5em; line-height: 1.35; }
.pttr-inner h1 { font-size: 1.55em; } .pttr-inner h2 { font-size: 1.3em; } .pttr-inner h3 { font-size: 1.13em; }
.pttr-inner p { margin: .55em 0; }
.pttr-inner ul, .pttr-inner ol { margin: .5em 0; padding-left: 1.6em; }
.pttr-inner li { margin: .22em 0; }
.pttr-inner blockquote { margin: .7em 0; padding: .35em .9em; border-left: 3px solid var(--dsw-alias-brand-primary, #4b7bec); color: var(--dsw-alias-label-secondary, #666); background: var(--dsw-alias-bg-layer-1, #f7f7f8); border-radius: 0 6px 6px 0; }
.pttr-inner pre { background: var(--dsw-alias-bg-layer-1, #f5f5f6); border: 1px solid var(--dsw-alias-border-l1, #e5e5e5); border-radius: 8px; padding: 12px 14px; overflow: auto; font-size: 13px; line-height: 1.55; }
.pttr-code { background: var(--dsw-alias-bg-layer-2, #ededf0); border-radius: 4px; padding: 1px 5px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .9em; }
.pttr-inner pre .pttr-code { background: transparent; padding: 0; }
.pttr-a { color: var(--dsw-alias-brand-primary, #4b7bec); }
.pttr-inner table { border-collapse: collapse; margin: .7em 0; font-size: 13.5px; }
.pttr-inner th, .pttr-inner td { border: 1px solid var(--dsw-alias-border-l1, #ddd); padding: 5px 10px; text-align: left; }
.pttr-inner th { background: var(--dsw-alias-bg-layer-1, #f5f5f6); }
.pttr-mark { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #ffd54d) 45%, transparent); border-radius: 3px; padding: 0 1px; }
.pttr-side { flex: none; border-left: 1px solid var(--dsw-alias-border-l1, #e5e5e5); display: flex; flex-direction: column; background: var(--dsw-alias-bg-layer-1, #fafafa); min-height: 0; min-width: 0; }
.pttr-sidehead { padding: 10px 14px 6px; font-weight: 650; font-size: 13px; flex: none; }
.pttr-hint { padding: 4px 14px 10px; color: var(--dsw-alias-label-secondary, #999); font-size: 12.5px; line-height: 1.6; }
.pttr-sidemid { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.pttr-annwrap { overflow: hidden; display: flex; flex-direction: column; min-height: 0; }
.pttr-annwrap .pttr-annlist { flex: 1; }
.pttr-sideglobal { flex: 1; min-height: 0; overflow: auto; padding: 6px 14px 8px; display: flex; flex-direction: column; gap: 6px; }
.pttr-annlist { flex: 1; overflow: auto; padding: 0 10px 8px; min-height: 0; }
.pttr-annitem { background: var(--dsw-alias-bg-overlay, #fff); border: 1px solid var(--dsw-alias-border-l1, #e5e5e5); border-radius: 8px; padding: 8px 10px; margin-bottom: 8px; }
.pttr-annhead { display: flex; align-items: center; gap: 7px; margin-bottom: 5px; }
.pttr-annno { flex: none; min-width: 18px; height: 18px; border-radius: 9px; background: var(--dsw-alias-state-warn-primary, #d69e2e); color: #fff; font-size: 11px; line-height: 18px; text-align: center; padding: 0 4px; }
.pttr-annquote { flex: 1; color: var(--dsw-alias-label-secondary, #777); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
.pttr-annquote:hover { color: var(--dsw-alias-brand-primary, #4b7bec); }
.pttr-x { flex: none; border: none; background: transparent; color: var(--dsw-alias-label-secondary, #999); cursor: pointer; font-size: 12px; padding: 2px 4px; border-radius: 4px; }
.pttr-x:hover { color: var(--dsw-alias-state-error-primary, #d64545); background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d64545) 10%, transparent); }
.pttr-note, .pttr-global, .pttr-popnote { width: 100%; border: 1px solid var(--dsw-alias-border-l1, #ddd); border-radius: 6px; background: var(--dsw-alias-bg-base, #fff); color: inherit; font: inherit; font-size: 13px; padding: 6px 8px; resize: vertical; }
.pttr-note:focus, .pttr-global:focus, .pttr-popnote:focus { outline: none; border-color: var(--dsw-alias-brand-primary, #4b7bec); }
.pttr-annloc { margin-top: 3px; font-size: 11px; color: var(--dsw-alias-label-secondary, #aaa); }
.pttr-global { min-height: 58px; }
.pttr-sideglobal .pttr-global { flex: 1 1 auto; min-height: 140px; }
.pttr-preview { font-size: 12px; color: var(--dsw-alias-label-secondary, #888); }
.pttr-preview summary { cursor: pointer; user-select: none; }
.pttr-previewbody { margin: 6px 0 0; white-space: pre-wrap; font-size: 12px; background: var(--dsw-alias-bg-layer-2, #f2f2f4); border-radius: 6px; padding: 8px; max-height: 140px; overflow: auto; }
.pttr-actions { display: flex; gap: 8px; align-items: center; justify-content: flex-end; flex: 1; }
.pttr-sidefoot { flex: none; padding: 10px 14px 12px; border-top: 1px solid var(--dsw-alias-border-l1, #e5e5e5); }
.pttr-btn { border: 1px solid transparent; border-radius: 8px; padding: 7px 14px; font-size: 13px; font-weight: 550; cursor: pointer; white-space: nowrap; }
.pttr-btn.pttr-sm { padding: 4px 10px; font-size: 12px; }
.pttr-ok { background: var(--dsw-alias-state-success-primary, #2e9e5b); color: #fff; }
.pttr-ok.pttr-armed { background: var(--dsw-alias-state-warn-primary, #d69e2e); }
.pttr-back { background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4b7bec) 12%, var(--dsw-alias-bg-base, #fff)); color: var(--dsw-alias-brand-primary, #3b6bd6); border-color: color-mix(in srgb, var(--dsw-alias-brand-primary, #4b7bec) 40%, transparent); }
.pttr-ghost { background: transparent; color: var(--dsw-alias-label-secondary, #777); border-color: var(--dsw-alias-border-l1, #ddd); }
.pttr-ghost:hover, .pttr-back:hover { filter: brightness(.97); }
.pttr-bottom { flex: none; border-top: 1px solid var(--dsw-alias-border-l1, #e5e5e5); display: flex; background: var(--dsw-alias-bg-layer-1, #fafafa); min-height: 0; }
.pttr-bottom-anns { flex: none; min-width: 0; display: flex; flex-direction: column; overflow: hidden; }
.pttr-bottom-global { flex: 1; min-width: 200px; display: flex; flex-direction: column; padding: 8px 12px 10px; gap: 6px; min-height: 0; }
.pttr-bottom-global .pttr-global { flex: 1; min-height: 60px; }
.pttr-dockbar { flex: none; display: flex; gap: 8px; padding: 9px 14px; border-top: 1px solid var(--dsw-alias-border-l1, #e5e5e5); background: var(--dsw-alias-bg-layer-1, #fafafa); align-items: center; }
.pttr-chip { position: fixed; transform: translateY(-100%); z-index: 45; pointer-events: auto; border: 1px solid var(--dsw-alias-border-l2, #ccc); background: var(--dsw-alias-bg-overlay, #fff); color: var(--dsw-alias-brand-primary, #3b6bd6); border-radius: 999px; padding: 4px 12px; font-size: 12.5px; font-weight: 600; cursor: pointer; box-shadow: 0 4px 14px rgba(0,0,0,.18); }
.pttr-chip:hover { background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4b7bec) 12%, var(--dsw-alias-bg-overlay, #fff)); }
.pttr-pop { pointer-events: auto; position: fixed; transform: translate(-50%, calc(-100% - 6px)); width: 330px; background: var(--dsw-alias-bg-overlay, #fff); border: 1px solid var(--dsw-alias-border-l2, #ccc); border-radius: 10px; box-shadow: 0 8px 30px rgba(0,0,0,.22); padding: 10px; z-index: 46; }
.pttr-popq { font-size: 12px; color: var(--dsw-alias-label-secondary, #888); margin-bottom: 6px; max-height: 60px; overflow: hidden; }
.pttr-popbtns { display: flex; gap: 6px; justify-content: flex-end; margin-top: 6px; }
.pttr-tray { position: fixed; right: 0; top: 15%; z-index: 44; display: flex; flex-direction: column; align-items: center; gap: 6px; pointer-events: none; }
.pttr-tabx { pointer-events: auto; width: 22px; height: 22px; border: 1px solid var(--dsw-alias-border-l2, #ccc); border-radius: 50%; background: var(--dsw-alias-bg-overlay, #fff); color: var(--dsw-alias-label-secondary, #888); font-size: 12px; line-height: 20px; text-align: center; cursor: pointer; padding: 0; }
.pttr-tabx:hover { color: var(--dsw-alias-state-error-primary, #d64545); border-color: var(--dsw-alias-state-error-primary, #d64545); }
.pttr-tab { pointer-events: auto; writing-mode: vertical-rl; padding: 14px 8px; background: var(--dsw-alias-bg-layer-2, #eee); color: var(--dsw-alias-label-primary, #333); border: 1px solid var(--dsw-alias-border-l2, #ccc); border-right: none; border-radius: 8px 0 0 8px; font-size: 13px; letter-spacing: 2px; cursor: pointer; box-shadow: -4px 0 14px rgba(0,0,0,.12); }
.pttr-tab.pttr-live { background: var(--dsw-alias-brand-primary, #4b7bec); color: #fff; }
.pttr-dot { display: inline-block; width: 8px; height: 8px; border-radius: 4px; background: var(--dsw-alias-state-error-primary, #ff5a5a); margin-bottom: 6px; animation: pttrpulse 1.2s infinite; }
.pttr-toast { pointer-events: auto; position: fixed; right: 44px; top: 72px; width: 320px; max-width: calc(100vw - 32px); padding: 10px 12px; cursor: pointer; z-index: 47; background: var(--dsw-alias-bg-overlay, #fff); border: 1px solid color-mix(in srgb, var(--dsw-alias-brand-primary, #4b7bec) 55%, transparent); border-left: 3px solid var(--dsw-alias-brand-primary, #4b7bec); border-radius: 10px; box-shadow: 0 10px 28px rgba(0,0,0,.22); animation: pttrtoast 3s ease-out forwards; }
.pttr-toasthead { display: flex; align-items: center; gap: 6px; font-size: 12.5px; font-weight: 650; color: var(--dsw-alias-brand-primary, #3b6bd6); }
.pttr-toastdot { flex: none; width: 8px; height: 8px; border-radius: 4px; background: var(--dsw-alias-state-error-primary, #ff5a5a); animation: pttrpulse 1.2s infinite; }
.pttr-toasttitle { margin-top: 4px; font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pttr-toastsub { margin-top: 3px; font-size: 11.5px; color: var(--dsw-alias-label-secondary, #888); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pttr-toastbtns { display: flex; gap: 6px; justify-content: flex-end; margin-top: 8px; }
.pttr-switch { flex: none; display: flex; align-items: center; gap: 6px; padding: 6px 18px; border-bottom: 1px solid var(--dsw-alias-border-l1, #e5e5e5); background: var(--dsw-alias-bg-layer-1, #fafafa); overflow-x: auto; }
.pttr-switchchip { flex: none; display: inline-flex; align-items: center; gap: 6px; max-width: 320px; border: 1px solid var(--dsw-alias-border-l1, #ddd); border-radius: 999px; padding: 3px 10px; font-size: 12px; cursor: pointer; color: var(--dsw-alias-label-secondary, #666); background: var(--dsw-alias-bg-overlay, #fff); }
.pttr-switchchip:hover { border-color: var(--dsw-alias-brand-primary, #4b7bec); color: var(--dsw-alias-brand-primary, #3b6bd6); }
.pttr-switchchip.on { border-color: var(--dsw-alias-brand-primary, #4b7bec); background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4b7bec) 12%, var(--dsw-alias-bg-overlay, #fff)); color: var(--dsw-alias-brand-primary, #3b6bd6); font-weight: 600; }
.pttr-switchchip.pttr-done { opacity: .62; }
.pttr-switchchip .pttr-swlabel { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pttr-switchchip .pttr-swsess { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 120px; opacity: .75; }
.pttr-switchchip .pttr-swx { border: none; background: transparent; color: inherit; cursor: pointer; font-size: 11px; line-height: 1; padding: 1px 2px; border-radius: 4px; }
.pttr-switchchip .pttr-swx:hover { color: var(--dsw-alias-state-error-primary, #d64545); }
.pttr-swnum { flex: none; min-width: 16px; height: 16px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2, #eee); color: var(--dsw-alias-label-secondary, #777); font-size: 10.5px; line-height: 16px; text-align: center; padding: 0 4px; }
.pttr-switchchip.on .pttr-swnum { background: var(--dsw-alias-brand-primary, #4b7bec); color: #fff; }
.pttr-session { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
.pttr-session .pttr-sestitle { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 260px; }
.pttr-subtxt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pttr-tag { flex: none; border-radius: 999px; padding: 1px 7px; font-size: 11px; background: var(--dsw-alias-bg-layer-2, #eee); color: var(--dsw-alias-label-secondary, #777); }
.pttr-tag.pttr-cur { background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #2e9e5b) 15%, transparent); color: var(--dsw-alias-state-success-primary, #2e9e5b); }
.pttr-tag.pttr-other { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d69e2e) 16%, transparent); color: var(--dsw-alias-state-warn-primary, #a87b1a); }
.pttr-jump { flex: none; border: 1px solid color-mix(in srgb, var(--dsw-alias-brand-primary, #4b7bec) 45%, transparent); background: transparent; color: var(--dsw-alias-brand-primary, #3b6bd6); border-radius: 6px; padding: 1px 7px; font-size: 11.5px; cursor: pointer; }
.pttr-jump:hover { background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4b7bec) 12%, transparent); }
.pttr-state { flex: none; width: 7px; height: 7px; border-radius: 4px; background: var(--dsw-alias-state-warn-primary, #d69e2e); }
.pttr-state.pttr-s-ok { background: var(--dsw-alias-state-success-primary, #2e9e5b); }
.pttr-state.pttr-s-mute { background: var(--dsw-alias-border-l2, #bbb); }
@keyframes pttrpulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
@keyframes pttrtoast { 0% { opacity: 0; transform: translateX(30px); } 8% { opacity: 1; transform: translateX(0); } 82% { opacity: 1; transform: translateX(0); } 100% { opacity: 0; transform: translateX(18px); } }
`;

		var CHANNEL = '/plannotator';
		var DRAFT_KEY = 'pttr-drafts-v1';
		/** Lifetime of the new-plan notification toast (JS timer and CSS animation share it). */
		var TOAST_MS = 3000;

		function readDrafts() {
			try {
				const raw = localStorage.getItem(DRAFT_KEY);
				const value = raw ? JSON.parse(raw) : null;
				return value && typeof value === 'object' ? value : {};
			} catch (e) { return {}; }
		}

		function writeDraft(reviewId, record) {
			if (!reviewId) return;
			try {
				const all = readDrafts();
				all[reviewId] = { anns: record.anns || [], globalNote: record.globalNote || '' };
				localStorage.setItem(DRAFT_KEY, JSON.stringify(all));
			} catch (e) {}
		}

		function dropDraft(reviewId) {
			if (!reviewId) return;
			try {
				const all = readDrafts();
				delete all[reviewId];
				localStorage.setItem(DRAFT_KEY, JSON.stringify(all));
			} catch (e) {}
		}

		/** Accept the current `{ reviews: [...] }` shape, a bare list, and a legacy single review. */
		function normalizePending(value) {
			const list = Array.isArray(value)
				? value
				: (value && Array.isArray(value.reviews) ? value.reviews : (value && typeof value.reviewId === 'string' ? [value] : []));
			return list.filter(function (r) { return r && typeof r.reviewId === 'string' && r.reviewId !== ''; });
		}

		/** Sort key shared by every "which plan is newest" choice. */
		function createdAtOf(review) {
			return review && typeof review.createdAt === 'number' ? review.createdAt : 0;
		}

		/**
		 * Newest live-pending review id in the panel's own items map. A `sessionId`
		 * string restricts the search; null/undefined means "any session". Returns
		 * null when nothing is waiting for a decision (so callers keep the current
		 * view instead of jumping to an already-decided plan).
		 */
		function newestLiveId(items, sessionId) {
			const restrict = typeof sessionId === 'string' && sessionId !== '';
			let best = null;
			let bestAt = 0;
			for (const id of items ? Object.keys(items) : []) {
				const rec = items[id];
				if (!rec || !rec.live || rec.status !== null) continue;
				const review = rec.review || {};
				if (restrict && review.sessionId !== sessionId) continue;
				const at = createdAtOf(review);
				if (best === null || at > bestAt) { best = id; bestAt = at; }
			}
			return best;
		}

		/**
		 * Newest review in a fresh (first-seen) batch owned by the current session:
		 * the only one allowed to take over the screen. Null when no fresh plan is
		 * ours — the rest are announced by the right-side toast instead.
		 */
		function pickFreshFocus(fresh, currentSession) {
			if (typeof currentSession !== 'string' || currentSession === '') return null;
			let best = null;
			let bestAt = 0;
			for (const r of fresh || []) {
				if (!r || r.sessionId !== currentSession) continue;
				const at = createdAtOf(r);
				if (best === null || at > bestAt) { best = r; bestAt = at; }
			}
			return best;
		}

		/**
		 * Fresh reviews that must NOT steal the screen (another session, or an
		 * unknown owner): exactly the ones the right-side toast announces.
		 */
		function notifyCandidates(fresh, currentSession) {
			const mine = typeof currentSession === 'string' && currentSession !== '' ? currentSession : null;
			return (fresh || []).filter(function (r) {
				return !!r && !(mine !== null && r.sessionId === mine);
			});
		}

		/**
		 * Plan the panel should show when nothing valid is active: the current
		 * session's newest live plan, else the newest live plan anywhere, else the
		 * newest record still kept in the panel (history of a decided plan).
		 */
		function autoSelectId(items, currentSession) {
			const mine = newestLiveId(items, currentSession);
			if (mine !== null) return mine;
			const anyLive = newestLiveId(items, null);
			if (anyLive !== null) return anyLive;
			let best = null;
			let bestAt = 0;
			for (const id of items ? Object.keys(items) : []) {
				const rec = items[id];
				if (!rec) continue;
				const at = createdAtOf(rec.review);
				if (best === null || at > bestAt) { best = id; bestAt = at; }
			}
			return best;
		}

		/** Session label, current/other marker, subagent lineage, and jump eligibility. */
		function sessionIdentity(review, listState, sessions) {
			const sid = review && typeof review.sessionId === 'string' && review.sessionId !== '' ? review.sessionId : null;
			const row = sid && listState && listState.byId ? listState.byId[sid] : undefined;
			const isCurrent = !!(sid && listState && listState.current === sid);
			const title = (row && row.displayTitle) || (review && review.sessionTitle) || (sid ? sid.slice(0, 8) : '');
			const isSub = !!(review && (review.origin === 'subagent' || review.parentSessionId))
				|| !!(row && (row.origin === 'subagent' || row.parentId));
			let canJump = false;
			if (sid && !isCurrent) {
				if (row) canJump = true;
				else if (sessions && typeof sessions.subagentAddress === 'function') {
					try { canJump = sessions.subagentAddress(sid) !== undefined; } catch (e) { canJump = false; }
				}
			}
			return { id: sid, title: title || '未知会话', current: isCurrent, subagent: isSub, canJump: canJump };
		}

		/** Subscribe a component to the live Session list (labels + current selection). */
		function useSessionList(service) {
			const subscribe = React.useCallback(function (listener) {
				if (!service || !service.list || typeof service.list.subscribe !== 'function') return function () {};
				return service.list.subscribe(listener);
			}, [service]);
			const getSnapshot = React.useCallback(function () {
				if (!service || !service.list || typeof service.list.getSnapshot !== 'function') return null;
				return service.list.getSnapshot();
			}, [service]);
			return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
		}

		function makeApp(ctx, api) {
			const sessionsService = (ctx.get && ctx.get('sessions')) || null;
			return function App() {
				const sessionsState = useSessionList(sessionsService);
				const [items, setItems] = React.useState({});
				const [activeId, setActiveId] = React.useState(null);
				const [mode, setMode] = React.useState('tab');
				const [chip, setChip] = React.useState(null);
				const [popOpen, setPopOpen] = React.useState(false);
				const [chipNote, setChipNote] = React.useState('');
				const [approveArmed, setApproveArmed] = React.useState(false);
				const [geo, setGeo] = React.useState(defaultGeo);
				// Appended after `geo` on purpose: the static validator seeds useState
				// slots by call order, so new state must stay at the tail.
				const [toast, setToast] = React.useState(null);
				// 工具箱开关（宿主 pending 应答的 enabled 字段；缺省视为启用）。
				const [tkEnabled, setTkEnabled] = React.useState(true);
				const knownRef = React.useRef({});
				const bootedRef = React.useRef(false);
				const toastRef = React.useRef(null);
				toastRef.current = toast;
				const toastTimerRef = React.useRef(null);
				const ref = React.useRef({ items: {}, activeId: null, mode: 'tab' });
				ref.current.items = items;
				ref.current.activeId = activeId;
				ref.current.mode = mode;
				const record = activeId && items[activeId] ? items[activeId] : null;
				const review = record ? record.review : null;
				const anns = record ? record.anns : [];
				const globalNote = record ? record.globalNote : '';
				const geoRef = React.useRef(geo);
				geoRef.current = geo;
				const contentRef = React.useRef(null);
				const rootRef = React.useRef(null);
				const connRef = React.useRef(ctx.get && ctx.get('connection'));

				function patchRecord(reviewId, patch) {
					if (!reviewId) return;
					const current = ref.current.items[reviewId];
					if (!current) return;
					const next = Object.assign({}, current, patch);
					if ('anns' in patch || 'globalNote' in patch) writeDraft(reviewId, next);
					setItems(function (prev) {
						if (!prev[reviewId]) return prev;
						const copy = Object.assign({}, prev);
						copy[reviewId] = Object.assign({}, prev[reviewId], patch);
						return copy;
					});
				}

				function dismissRecord(reviewId) {
					dropDraft(reviewId);
					setItems(function (prev) {
						if (!prev[reviewId]) return prev;
						const copy = Object.assign({}, prev);
						delete copy[reviewId];
						return copy;
					});
				}

				function setAnnsFor(list) { patchRecord(ref.current.activeId, { anns: list }); }
				function setNoteFor(text) { patchRecord(ref.current.activeId, { globalNote: text }); }

				function jumpToSession(sessionId) {
					if (!sessionId || !sessionsService) return;
					try {
						const state = sessionsService.list && typeof sessionsService.list.getSnapshot === 'function'
							? sessionsService.list.getSnapshot()
							: null;
						if (state && state.byId && state.byId[sessionId]) { sessionsService.open(sessionId); return; }
						if (typeof sessionsService.subagentAddress === 'function' && typeof sessionsService.openSubagent === 'function') {
							const address = sessionsService.subagentAddress(sessionId);
							if (address !== undefined) sessionsService.openSubagent(address);
						}
					} catch (e) { console.error('plannotator: jump to session failed', e); }
				}

				function rpc(endpoint, payload) {
					const connection = ctx.connection;
					if (connection === undefined) return Promise.reject(new Error('plannotator: connection service unavailable'));
					return connection.rpc.call(CHANNEL, endpoint, payload === undefined ? {} : payload).then(function (res) {
						if (res && res.ok === false) throw new Error((res.error && res.error.message) || 'plannotator rpc error');
						return res ? res.value : undefined;
					});
				}

				/** Drop the toast and cancel its pending auto-dismiss timer. */
				function clearToast() {
					const dispose = toastTimerRef.current;
					toastTimerRef.current = null;
					if (typeof dispose === 'function') dispose();
					setToast(null);
				}

				/**
				 * Flash the right-side notification for fresh plan reviews that did
				 * not take over the screen (another session's plan). Purely an
				 * attention cue: it never changes `activeId` or `mode`, and it
				 * disappears on its own after TOAST_MS.
				 */
				function showToast(candidates, listState) {
					if (!candidates || candidates.length === 0) return;
					const sorted = candidates.slice().sort(function (a, b) { return createdAtOf(b) - createdAtOf(a); });
					const primary = sorted[0];
					const info = sessionIdentity(primary, listState, sessionsService);
					clearToast();
					setToast({
						key: Date.now(),
						primaryId: primary.reviewId,
						sessionId: info.id,
						count: candidates.length,
						title: firstHeading(primary.plan) || primary.header || '计划评审',
						sessionLabel: info.title,
						subagent: info.subagent,
						canJump: info.canJump
					});
					toastTimerRef.current = ctx.timeout(clearToast, TOAST_MS);
				}

				/**
				 * Open the panel on the newest plan awaiting a decision: the newest
				 * live review, or `preferredId` when it is still known. Without any
				 * pending review the current view is kept (history playback).
				 */
				function openPanel(targetMode, preferredId) {
					const itemsNow = ref.current.items;
					const pick = preferredId && itemsNow[preferredId] ? preferredId : newestLiveId(itemsNow);
					if (pick !== null && pick !== ref.current.activeId) setActiveId(pick);
					setMode(targetMode);
				}

				React.useEffect(function () {
					let alive = true;
					rpc('hello').catch(function () {});
					const stop = ctx.interval(function () {
						rpc('pending').then(function (value) {
							if (!alive) return;
							setTkEnabled(!(value && value.enabled === false));
							const list = normalizePending(value);
							const known = knownRef.current;
							const live = {};
							const fresh = [];
							for (const r of list) {
								live[r.reviewId] = true;
								if (!known[r.reviewId]) { known[r.reviewId] = true; fresh.push(r); }
							}
							for (const id of Object.keys(known)) { if (!live[id]) delete known[id]; }
							// Only a successful poll proves the queue was observed: the
							// first one must not fire a toast for pre-existing reviews.
							const firstPoll = !bootedRef.current;
							bootedRef.current = true;
							const sessionsSnapshot = sessionsService && sessionsService.list && typeof sessionsService.list.getSnapshot === 'function'
								? sessionsService.list.getSnapshot()
								: null;
							const currentSession = sessionsSnapshot ? sessionsSnapshot.current : undefined;
							const drafts = fresh.length > 0 ? readDrafts() : null;
							setItems(function (prev) {
								const next = Object.assign({}, prev);
								let changed = false;
								for (const r of list) {
									const existing = prev[r.reviewId];
									if (!existing) {
										const draft = (drafts && drafts[r.reviewId]) || {};
										next[r.reviewId] = {
											review: r,
											live: true,
											status: null,
											anns: Array.isArray(draft.anns) ? draft.anns : [],
											globalNote: typeof draft.globalNote === 'string' ? draft.globalNote : ''
										};
										changed = true;
									} else if (!existing.live) {
										next[r.reviewId] = Object.assign({}, existing, { live: true });
										changed = true;
									}
								}
								for (const id of Object.keys(next)) {
									if (!live[id] && next[id].live) {
										next[id] = Object.assign({}, next[id], { live: false, status: next[id].status === null ? 'closed' : next[id].status });
										changed = true;
									}
								}
								return changed ? next : prev;
							});
							const focus = pickFreshFocus(fresh, currentSession);
							if (focus) {
								setActiveId(focus.reviewId);
								setMode('full');
							} else if (fresh.length > 0 && ref.current.mode === 'hidden') {
								setMode('tab');
							}
							const candidates = notifyCandidates(fresh, currentSession);
							if (!firstPoll && candidates.length > 0) showToast(candidates, sessionsSnapshot);
						}).catch(function () {});
					}, 400);
					return function () { alive = false; stop(); };
				}, [sessionsService]);

				React.useEffect(function () {
					try {
						const raw = localStorage.getItem('pttr-geom-v1');
						if (raw) {
							const g = JSON.parse(raw);
							const d = defaultGeo();
							setGeo({
								leftFull: typeof g.leftFull === 'number' ? g.leftFull : d.leftFull,
								leftDock: typeof g.leftDock === 'number' ? g.leftDock : d.leftDock,
								dockBottomH: typeof g.dockBottomH === 'number' ? clampV(g.dockBottomH, 140, 900) : d.dockBottomH,
								annSplit: typeof g.annSplit === 'number' ? clampV(g.annSplit, 0.25, 0.75) : d.annSplit,
								sideW: typeof g.sideW === 'number' ? clampV(g.sideW, 260, 680) : d.sideW,
								sideSplit: typeof g.sideSplit === 'number' ? clampV(g.sideSplit, 0.2, 0.8) : d.sideSplit
							});
						}
					} catch (e) {}
				}, []);

				function persistGeo(next) {
					setGeo(next);
					try { localStorage.setItem('pttr-geom-v1', JSON.stringify(next)); } catch (e) {}
				}

				React.useEffect(function () {
					const onKey = function (ev) {
						if (ev.key !== 'Escape') return;
						const tag = ev.target && ev.target.tagName;
						if (tag === 'TEXTAREA' || tag === 'INPUT') return;
						const m = ref.current.mode;
						if (m === 'full') setMode('dock');
						else if (m === 'dock') setMode('tab');
					};
					document.addEventListener('keydown', onKey);
					return function () { document.removeEventListener('keydown', onKey); };
				}, []);

				React.useEffect(function () {
					setChip(null);
					setPopOpen(false);
					setChipNote('');
					setApproveArmed(false);
				}, [activeId]);

				React.useEffect(function () {
					const ids = Object.keys(items).filter(function (id) { return items[id]; });
					if (ids.length === 0) return;
					if (activeId && items[activeId]) return;
					const currentSession = sessionsState ? sessionsState.current : undefined;
					const pick = autoSelectId(items, currentSession);
					if (pick !== null && pick !== activeId) setActiveId(pick);
				}, [items, activeId, sessionsState]);

				const blocks = React.useMemo(function () {
					return review ? parseBlocks(review.plan) : [];
				}, [review ? review.reviewId : '']);

				function vw() {
					return (document.documentElement && document.documentElement.clientWidth) || 1200;
				}

				function effectiveLeft() {
					if (mode === 'full') return geo.leftFull !== null ? geo.leftFull : 0;
					return geo.leftDock !== null ? geo.leftDock : Math.round(vw() * 0.58);
				}

				function startEdgeDrag(ev, kind) {
					if (ev.button !== 0) return;
					ev.preventDefault();
					const g0 = geoRef.current;
					const sx = ev.clientX;
					const start = kind === 'leftFull'
						? (g0.leftFull !== null ? g0.leftFull : 0)
						: (g0.leftDock !== null ? g0.leftDock : Math.round(vw() * 0.58));
					let last = null;
					function onMove(e2) {
						const v = clampV(start + e2.clientX - sx, 240, vw() - 340);
						last = Object.assign({}, geoRef.current);
						if (kind === 'leftFull') last.leftFull = v;
						else last.leftDock = v;
						setGeo(last);
					}
					function onUp() {
						document.removeEventListener('mousemove', onMove);
						document.removeEventListener('mouseup', onUp);
						if (last) persistGeo(last);
					}
					document.addEventListener('mousemove', onMove);
					document.addEventListener('mouseup', onUp);
				}

				function startSplit(ev, kind) {
					if (ev.button !== 0) return;
					ev.preventDefault();
					const g0 = geoRef.current;
					const sx = ev.clientX;
					const sy = ev.clientY;
					const cont = ev.currentTarget.parentElement;
					const crect = cont ? cont.getBoundingClientRect() : null;
					const start = kind === 'dockBottomH' ? g0.dockBottomH
						: kind === 'annSplit' ? g0.annSplit
						: kind === 'sideW' ? g0.sideW
						: g0.sideSplit;
					let last = null;
					function onMove(e2) {
						const next = Object.assign({}, geoRef.current);
						if (kind === 'dockBottomH') next.dockBottomH = clampV(start - (e2.clientY - sy), 140, (window.innerHeight || 900) - 220);
						else if (kind === 'annSplit') next.annSplit = clampV(start + (e2.clientX - sx) / Math.max(1, crect ? crect.width : 800), 0.25, 0.75);
						else if (kind === 'sideW') next.sideW = clampV(start - (e2.clientX - sx), 260, 680);
						else if (kind === 'sideSplit') next.sideSplit = clampV(start + (e2.clientY - sy) / Math.max(1, crect ? crect.height : 600), 0.2, 0.8);
						last = next;
						setGeo(next);
					}
					function onUp() {
						document.removeEventListener('mousemove', onMove);
						document.removeEventListener('mouseup', onUp);
						if (last) persistGeo(last);
					}
					document.addEventListener('mousemove', onMove);
					document.addEventListener('mouseup', onUp);
				}

				function buildFeedback() {
					const lines = [];
					anns.forEach(function (a, i) {
						const loc = a.block >= 0 ? '（计划第 ' + (a.block + 1) + ' 块）' : '';
						lines.push(String(i + 1) + '. 划线「' + a.quote + '」' + loc + '\n   批注意见：' + (a.note && a.note.trim() !== '' ? a.note.trim() : '（无文字说明，请结合上下文理解该选段的问题）'));
					});
					const g = globalNote.trim();
					if (g !== '') lines.push('【总体意见】' + g);
					return lines.join('\n');
				}

				function decide(kind) {
					const target = ref.current.activeId ? ref.current.items[ref.current.activeId] : null;
					if (!target || !target.live || target.status !== null) return;
					if (kind === 'approve' && !approveArmed) {
						setApproveArmed(true);
						ctx.timeout(function () { setApproveArmed(false); }, 3000);
						return;
					}
					const reviewId = target.review.reviewId;
					patchRecord(reviewId, { status: kind === 'approve' ? 'approved' : (kind === 'feedback' ? 'sent' : 'dismissed') });
					setApproveArmed(false);
					closeChip();
					setMode('tab');
					if (toastRef.current && toastRef.current.primaryId === reviewId) clearToast();
					rpc('decide', { reviewId: reviewId, decision: kind, feedback: kind === 'approve' ? '' : buildFeedback() }).catch(function (e) { console.error('plannotator decide failed', e); });
				}

				function delAnn(id) { setAnnsFor(anns.filter(function (a) { return a.id !== id; })); }

				function jumpTo(block) {
					const cont = contentRef.current;
					if (!cont || block < 0) return;
					const el = cont.querySelector('[data-pb="' + block + '"]');
					if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
				}

				function closeChip() { setChip(null); setPopOpen(false); setChipNote(''); }

				function onMouseDown() { if (chip) closeChip(); }

				function onMouseUp(ev) {
					if (ev.button !== 0) return;
					const cont = contentRef.current;
					if (!cont) return;
					const sel = document.getSelection ? document.getSelection() : null;
					if (!sel || sel.isCollapsed || sel.rangeCount === 0) { return; }
					const text = sel.toString().replace(/\s+/g, ' ').trim();
					if (text.length < 2) { return; }
					const range = sel.getRangeAt(0);
					let block = -1;
					const els = cont.querySelectorAll('[data-pb]');
					for (let i = 0; i < els.length; i++) {
						if (range.intersectsNode(els[i])) { block = Number(els[i].getAttribute('data-pb')); break; }
					}
					const rect = range.getBoundingClientRect();
					setChip({ x: rect.left + rect.width / 2, y: rect.top, quote: text.slice(0, 300), block: block });
					setPopOpen(false);
					setChipNote('');
				}

				function addAnnotation() {
					if (!chip) return;
					setAnnsFor(anns.concat([{ id: Date.now(), quote: chip.quote, block: chip.block, note: chipNote }]));
					const sel = document.getSelection ? document.getSelection() : null;
					if (sel) sel.removeAllRanges();
					closeChip();
				}

				const visibleIds = Object.keys(items).filter(function (id) { return items[id]; });
				if (visibleIds.length === 0) return null;
				const orderedIds = visibleIds.slice().sort(function (a, b) {
					return (items[a].review.createdAt || 0) - (items[b].review.createdAt || 0);
				});
				const liveCount = visibleIds.filter(function (id) { return items[id].live && items[id].status === null; }).length;
				const active = record ? record.status === null && record.live : false;
				const title = record ? firstHeading(record.review.plan) : '';
				const hasNotes = anns.length > 0 || globalNote.trim() !== '';
				const banners = {
					approved: { cls: 'ok', text: '已通过：模型将开始执行该计划。' },
					sent: { cls: 'back', text: '意见已发送：模型将修订计划后再次提交。' },
					dismissed: { cls: 'warn', text: '已取消评审：计划保留在此供对照，请直接在聊天输入你的意见。' },
					closed: { cls: 'mute', text: '该计划评审已结束或被取消。' }
				};

				function stateClass(id) {
					const rec = items[id];
					if (rec.status === 'approved' || rec.status === 'sent') return 'pttr-s-ok';
					if (rec.status === 'dismissed' || !rec.live) return 'pttr-s-mute';
					return '';
				}

				function sessionChip(id) {
					const rec = items[id];
					if (!rec) return null;
					const info = sessionIdentity(rec.review, sessionsState, sessionsService);
					const children = [
						E('span', { className: 'pttr-sestitle', key: 'title', title: info.id || '' }, info.title),
						E('span', { className: 'pttr-tag ' + (info.current ? 'pttr-cur' : 'pttr-other'), key: 'tag' },
							info.current ? '当前会话' : (info.subagent ? '子会话' : '其他会话'))
					];
					if (info.canJump) {
						children.push(E('button', {
							className: 'pttr-jump', key: 'jump', type: 'button',
							title: '切换到该会话查看上下文',
							onClick: function () { jumpToSession(info.id); }
						}, '前往会话'));
					}
					return E('span', { className: 'pttr-session' }, children);
				}

				function renderBlock(b, idx) {
					const mine = anns.filter(function (a) { return a.block === idx; });
					const nums = mine.map(function (a) { return anns.indexOf(a) + 1; }).join(',');
					const quotes = mine.map(function (a) { return a.quote; });
					let body = null;
					if (b.type === 'h') body = E('h' + Math.max(1, Math.min(6, b.level)), { key: 'c' }, renderInlineMarked(b.text, quotes, 'h' + idx));
					else if (b.type === 'p') body = E('p', { key: 'c' }, renderInlineMarked(b.text, quotes, 'p' + idx));
					else if (b.type === 'quote') body = E('blockquote', { key: 'c' }, renderInlineMarked(b.text, quotes, 'q' + idx));
					else if (b.type === 'list') body = E(b.ordered ? 'ol' : 'ul', { key: 'c' }, b.items.map(function (it, i2) { return E('li', { key: i2 }, inlineNodes(it, 'li' + idx + '-' + i2)); }));
					else if (b.type === 'code') body = E('pre', { key: 'c' }, E('code', null, b.text));
					else if (b.type === 'table') body = E('table', { key: 'c' }, E('tbody', null, b.rows.map(function (r, ri) { return E('tr', { key: ri }, r.map(function (c, ci) { return E(ri === 0 ? 'th' : 'td', { key: ci }, inlineNodes(c, 't' + idx + ri + '-' + ci)); })); })));
					else if (b.type === 'hr') body = E('hr', { key: 'c' });
					return E('div', { key: idx, className: 'pttr-block' + (mine.length ? ' pttr-ann' : ''), 'data-pb': idx },
						mine.length ? E('span', { className: 'pttr-badge' }, nums) : null,
						body);
				}

				function annItem(a, i) {
					const children = [
						E('div', { className: 'pttr-annhead' },
							E('span', { className: 'pttr-annno' }, String(i + 1)),
							E('span', { className: 'pttr-annquote', title: a.quote, onClick: function () { jumpTo(a.block); } }, '「' + a.quote + '」'),
							E('button', { className: 'pttr-x', title: '删除该批注', onClick: function () { delAnn(a.id); } }, '✕')),
						E('textarea', {
							className: 'pttr-note',
							rows: 3,
							placeholder: '这段的意见…（可留空）',
							value: a.note,
							onChange: function (ev) {
								const v = ev.target.value;
								setAnnsFor(anns.map(function (x) {
									return x.id === a.id ? Object.assign({}, x, { note: v }) : x;
								}));
							}
						})
					];
					if (a.block >= 0) children.push(E('div', { className: 'pttr-annloc' }, '位于第 ' + (a.block + 1) + ' 块 · 点击引文定位'));
					return E('div', { className: 'pttr-annitem', key: a.id }, children);
				}

				function buttonsRow() {
					if (!active) return null;
					return E('div', { className: 'pttr-actions' },
						E('button', { className: 'pttr-btn pttr-ghost', onClick: function () { decide('dismiss'); }, title: '关闭评审界面，留在计划模式等你在聊天输入' }, '取消'),
						hasNotes
							? E('button', { className: 'pttr-btn pttr-back', onClick: function () { decide('feedback'); }, title: '把批注与总体意见发回给模型，模型将修订计划后再次提交' }, '发送意见' + (anns.length ? '（' + anns.length + '）' : ''))
							: E('button', { className: 'pttr-btn pttr-ok' + (approveArmed ? ' pttr-armed' : ''), onClick: function () { decide('approve'); }, title: '没有任何意见即视为通过；再次点击确认' }, approveArmed ? '确认通过？' : '通过计划'));
				}

				const switcher = orderedIds.length > 1
					? E('div', { className: 'pttr-switch' },
						orderedIds.map(function (id, i) {
							const rec = items[id];
							const label = firstHeading(rec.review.plan) || ('计划 ' + (i + 1));
							const info = sessionIdentity(rec.review, sessionsState, sessionsService);
							const kids = [
								E('span', { className: 'pttr-state ' + stateClass(id), key: 'dot' }),
								E('span', { className: 'pttr-swnum', key: 'num' }, String(i + 1)),
								E('span', { className: 'pttr-swlabel', key: 'label', title: label }, label),
								E('span', { className: 'pttr-swsess', key: 'sess', title: info.title }, '· ' + info.title)
							];
							if (info.current) kids.push(E('span', { className: 'pttr-tag pttr-cur', key: 'cur' }, '当前'));
							if (!rec.live) {
								kids.push(E('button', {
									className: 'pttr-swx', key: 'x', type: 'button', title: '移除这条已结束的评审',
									onClick: function (ev) { ev.stopPropagation(); dismissRecord(id); }
								}, '✕'));
							}
							return E('div', {
								className: 'pttr-switchchip' + (id === activeId ? ' on' : '') + (rec.live ? '' : ' pttr-done'),
								key: id, role: 'button', tabIndex: 0,
								onClick: function () { setActiveId(id); closeChip(); },
								onKeyDown: function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); setActiveId(id); closeChip(); } }
							}, kids);
						}))
					: null;

				const preview = E('details', { className: 'pttr-preview' },
					E('summary', null, '将发送的意见预览'),
					E('pre', { className: 'pttr-previewbody' }, buildFeedback() || '（暂无意见；此时按钮为「通过计划」）'));

				const annListEl = anns.length ? E('div', { className: 'pttr-annlist' }, anns.map(annItem)) : null;

				const sidebar = E('div', { className: 'pttr-side', style: { width: geo.sideW + 'px' } },
					E('div', { className: 'pttr-sidehead' }, '批注与意见' + (anns.length ? '（' + anns.length + '）' : '')),
					E('div', { className: 'pttr-sidemid' },
						E('div', { className: 'pttr-annwrap', style: { height: (geo.sideSplit * 100) + '%' } },
							anns.length === 0 ? E('div', { className: 'pttr-hint' }, '选中计划文字，点击浮出的「批注此段」按钮添加批注；也可以只填总体意见。') : null,
							annListEl),
						E('div', { className: 'pttr-split-h', onMouseDown: function (ev) { startSplit(ev, 'sideSplit'); }, title: '拖动调整批注区高度' }),
						E('div', { className: 'pttr-sideglobal' },
							E('textarea', { className: 'pttr-global', placeholder: '总体意见（对整个计划）…', value: globalNote, onChange: function (ev) { setNoteFor(ev.target.value); }, onKeyDown: function (ev) { if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey) && hasNotes) decide('feedback'); } }),
							preview)),
					E('div', { className: 'pttr-sidefoot' }, buttonsRow()));

				const bottomArea = mode === 'dock'
					? E('div', { className: 'pttr-bottom', style: { height: geo.dockBottomH + 'px' } },
						E('div', { className: 'pttr-bottom-anns', style: { width: (geo.annSplit * 100) + '%' } },
							E('div', { className: 'pttr-sidehead' }, '批注' + (anns.length ? '（' + anns.length + '）' : '（0）')),
							anns.length === 0 ? E('div', { className: 'pttr-hint' }, '选中计划文字，点击浮出的「批注此段」按钮添加批注。') : null,
							annListEl),
						E('div', { className: 'pttr-split-v', onMouseDown: function (ev) { startSplit(ev, 'annSplit'); }, title: '拖动调整批注区宽度' }),
						E('div', { className: 'pttr-bottom-global' },
							E('div', { className: 'pttr-sidehead' }, '总体意见'),
							E('textarea', { className: 'pttr-global', placeholder: '对整个计划的意见…（Ctrl+Enter 发送意见）', value: globalNote, onChange: function (ev) { setNoteFor(ev.target.value); }, onKeyDown: function (ev) { if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey) && hasNotes) decide('feedback'); } }),
							preview))
					: null;

				const chipEl = chip && !popOpen
					? E('button', { className: 'pttr-chip', style: { left: chip.x + 'px', top: (chip.y - 6) + 'px' }, onMouseDown: function (ev) { ev.preventDefault(); }, onClick: function () { setPopOpen(true); }, title: '对选中文字添加批注（复制不受影响）' }, '💬 批注此段')
					: null;

				const popEl = chip && popOpen
					? E('div', { className: 'pttr-pop', style: { left: chip.x + 'px', top: (chip.y - 6) + 'px' } },
						E('div', { className: 'pttr-popq' }, '「' + chip.quote + (chip.quote.length >= 300 ? '…' : '') + '」'),
						E('textarea', { className: 'pttr-popnote', rows: 3, autoFocus: true, placeholder: '对这段的意见…（Ctrl+Enter 添加）', value: chipNote, onChange: function (ev) { setChipNote(ev.target.value); }, onKeyDown: function (ev) { if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) addAnnotation(); else if (ev.key === 'Escape') closeChip(); } }),
						E('div', { className: 'pttr-popbtns' },
							E('button', { className: 'pttr-btn pttr-back pttr-sm', onClick: addAnnotation }, '添加批注'),
							E('button', { className: 'pttr-btn pttr-ghost pttr-sm', onClick: closeChip }, '取消')))
					: null;

				const banner = record && record.status
					? E('div', { className: 'pttr-banner pttr-b-' + banners[record.status].cls }, banners[record.status].text)
					: null;

				// Right-side notification flash for a plan that arrived from *another*
				// session: it announces the plan without stealing the current view.
				const toastEl = toast
					? E('div', {
						className: 'pttr-toast',
						key: toast.key,
						role: 'status',
						'aria-live': 'polite',
						style: { animationDuration: TOAST_MS + 'ms' },
						title: '点击查看该计划评审',
						onClick: function () { clearToast(); openPanel('dock', toast.primaryId); }
					},
						E('div', { className: 'pttr-toasthead' },
							E('span', { className: 'pttr-toastdot' }),
							E('span', null, toast.count > 1 ? toast.count + ' 个新计划待评审' : '新计划待评审')),
						E('div', { className: 'pttr-toasttitle' }, toast.title),
						E('div', { className: 'pttr-toastsub' },
							'「' + toast.sessionLabel + '」' + (toast.subagent ? ' · 子会话' : '') + ' · 点击查看'),
						E('div', { className: 'pttr-toastbtns' },
							toast.canJump
								? E('button', {
									className: 'pttr-jump', type: 'button', title: '切换到该会话查看上下文',
									onClick: function (ev) { ev.stopPropagation(); clearToast(); jumpToSession(toast.sessionId); }
								}, '前往会话')
								: null,
							E('button', {
								className: 'pttr-x', type: 'button', title: '关闭提示',
								onClick: function (ev) { ev.stopPropagation(); clearToast(); }
							}, '✕')))
					: null;

				// 工具箱开关：关闭且没有任何在途/历史评审时整块不渲染（在途评审保留可决策）。
				if (!tkEnabled && liveCount === 0 && Object.keys(items).length === 0) return null;

				return E('div', { className: 'pttr-root', ref: rootRef },
					mode === 'tab'
						? E('div', { className: 'pttr-tray' },
							E('button', { className: 'pttr-tabx', title: '关闭评审面板（隐藏，不结束评审）', onClick: function () { setMode('hidden'); } }, '✕'),
							E('button', { className: 'pttr-tab' + (liveCount ? ' pttr-live' : ''), onClick: function () { openPanel('dock'); }, title: liveCount ? liveCount + ' 个计划待评审' : '查看计划评审' },
								liveCount ? E('span', { className: 'pttr-dot' }) : null,
								'计划评审' + (liveCount ? '（' + liveCount + '）' : '')))
						: null,
					mode !== 'tab' && mode !== 'hidden' && record
						? E('div', { className: 'pttr-panel' + (mode === 'dock' ? ' pttr-shadow' : ''), style: { left: effectiveLeft() + 'px' } },
							E('div', { className: 'pttr-dragstrip', onMouseDown: function (ev) { startEdgeDrag(ev, mode === 'full' ? 'leftFull' : 'leftDock'); }, title: '拖动调整左边界' }),
							E('div', { className: 'pttr-head' },
								E('div', { className: 'pttr-title' }, title || '计划评审'),
								E('div', { className: 'pttr-sub' },
									sessionChip(activeId),
									E('span', { className: 'pttr-subtxt' }, (record.review.header || 'Plan review') + (liveCount > 1 ? ' · 待评审 ' + liveCount + ' 个' : ''))),
								E('div', { className: 'pttr-modes' },
									E('button', { className: 'pttr-modebtn' + (mode === 'full' ? ' on' : ''), onClick: function () { setMode('full'); }, title: '占满整个工作区' }, '全屏'),
									E('button', { className: 'pttr-modebtn' + (mode === 'dock' ? ' on' : ''), onClick: function () { setMode('dock'); }, title: '折叠到右侧，可查看对话' }, '右侧'),
									E('button', { className: 'pttr-modebtn' + (mode === 'tab' ? ' on' : ''), onClick: function () { setMode('tab'); }, title: '收起为右缘托盘' }, '收起'))),
							switcher,
							banner,
							E('div', { className: 'pttr-body' },
								E('div', { className: 'pttr-content', ref: contentRef, onMouseUp: onMouseUp, onMouseDown: onMouseDown },
									E('div', { className: 'pttr-inner' }, blocks.map(renderBlock))),
								mode === 'full' ? E('div', { className: 'pttr-split-v', onMouseDown: function (ev) { startSplit(ev, 'sideW'); }, title: '拖动调整批注栏宽度' }) : null,
								mode === 'full' ? sidebar : null),
							mode === 'dock' ? E('div', { className: 'pttr-split-h', onMouseDown: function (ev) { startSplit(ev, 'dockBottomH'); }, title: '拖动调整意见区高度' }) : null,
							bottomArea,
							mode === 'dock' ? E('div', { className: 'pttr-dockbar' }, buttonsRow()) : null,
							chipEl,
							popEl)
						: null,
					toastEl);
			};
		}

		var inject = ['slots', 'connection', 'timer', 'sessions'];

		function apply(ctx, api) {
			const slots = ctx.get('slots');
			if (slots === undefined) return;
			ctx.effect(function () {
				// 幂等注入：HMR 热替换时先移除旧标签，避免新旧样式叠加。
				const stale = document.head.querySelector('style[data-plannotator="embedded"]');
				if (stale) stale.remove();
				const tag = document.createElement('style');
				tag.dataset.plannotator = 'embedded';
				tag.textContent = CSS;
				document.head.append(tag);
				return function () { tag.remove(); };
			}, 'plannotator: stylesheet');
			slots.inject('shell.overlay', function () {
				return slots.register({ name: 'shell.overlay', id: 'plannotator-review', order: 60, label: 'Plannotator 计划评审' }, makeApp(ctx, api));
			});
		}

		// 工具箱注册：mount = 原 apply(ctx, api)；门控点在 App 渲染与宿主监听器内。
		// （RPC 通道在功能关闭时保持在线，宿主负责放行新评审、面板负责收尾在途评审。）
		TK.features.plannotator = { mount: function (ctx, api) { return apply(ctx, api); } };
	}
