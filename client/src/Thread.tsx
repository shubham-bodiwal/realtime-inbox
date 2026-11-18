import { ArrowClockwise, Check, Checks, Clock, PaperPlaneRight, WarningCircle } from '@phosphor-icons/react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { MAX_BODY, type Message } from '../../shared/protocol.ts';
import { time } from './identity.ts';
import type { ConvState, Pending } from './inbox.ts';

interface Props {
  me: string;
  conv: ConvState;
  pending: Pending[];
  empty: string;
  onSend: (body: string) => void;
  onRetry: (clientId: string) => void;
  onTyping: (on: boolean) => void;
}

type Row = { key: string; from: string; fromName: string; body: string; at: number; msg?: Message; pending?: Pending };

export function Thread({ me, conv, pending, empty, onSend, onRetry, onTyping }: Props) {
  const [draft, setDraft] = useState('');
  const list = useRef<HTMLDivElement>(null);
  const rows: Row[] = [
    ...conv.messages.map((m) => ({ key: m.id, from: m.from, fromName: m.fromName, body: m.body, at: m.at, msg: m })),
    ...pending.map((p) => ({ key: p.clientId, from: me, fromName: '', body: p.body, at: p.at, pending: p })),
  ];
  const lastMine = conv.messages.findLast((m) => m.from === me);
  const seen = lastMine && Object.entries(conv.summary.reads).some(([u, s]) => u !== me && s >= lastMine.seq);
  const typers = Object.values(conv.typing).map((t) => t.name);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when a row or typing indicator is added
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [rows.length, typers.length]);

  const submit = () => {
    if (!draft.trim()) return;
    onSend(draft);
    onTyping(false);
    setDraft('');
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="thread">
      <div className="messages" ref={list} role="log" aria-live="polite" aria-label="Messages">
        {rows.length === 0 && <p className="empty">{empty}</p>}
        {rows.map((r, i) => {
          const mine = r.from === me;
          const firstOfGroup = rows[i - 1]?.from !== r.from;
          return (
            <div key={r.key} className={`row ${mine ? 'mine' : 'theirs'} ${firstOfGroup ? 'first' : ''}`}>
              {!mine && firstOfGroup && <span className="who">{r.fromName}</span>}
              <div className={`bubble ${r.pending ? `is-${r.pending.state}` : ''}`}>{r.body}</div>
              <Meta row={r} mine={mine} isLastMine={r.msg?.id === lastMine?.id} seen={!!seen} onRetry={onRetry} />
            </div>
          );
        })}
        {typers.length > 0 && (
          <div className="typing">
            <span aria-hidden="true" /><span aria-hidden="true" /><span aria-hidden="true" />
            <em>{typers.join(', ')} is typing</em>
          </div>
        )}
      </div>
      <form className="composer" onSubmit={(e) => (e.preventDefault(), submit())}>
        <label className="sr-only" htmlFor={`draft-${conv.summary.id}`}>Message</label>
        <textarea
          id={`draft-${conv.summary.id}`}
          rows={1}
          value={draft}
          maxLength={MAX_BODY}
          placeholder="Write a reply"
          onChange={(e) => {
            setDraft(e.target.value);
            onTyping(e.target.value.length > 0);
          }}
          onBlur={() => onTyping(false)}
          onKeyDown={onKey}
        />
        <button type="submit" className="send" aria-label="Send" disabled={!draft.trim()}>
          <PaperPlaneRight size={18} weight="fill" />
        </button>
      </form>
    </div>
  );
}

function Meta({ row, mine, isLastMine, seen, onRetry }: { row: Row; mine: boolean; isLastMine: boolean; seen: boolean; onRetry: (id: string) => void }) {
  const p = row.pending;
  if (p?.state === 'failed')
    return (
      <span className="meta failed">
        <WarningCircle size={14} weight="bold" /> {p.error ?? 'Not delivered'}
        <button type="button" onClick={() => onRetry(p.clientId)}>
          <ArrowClockwise size={13} weight="bold" /> Retry
        </button>
      </span>
    );
  if (p) return <span className="meta"><Clock size={13} /> Sending</span>;
  if (!mine || !isLastMine) return <span className="meta subtle">{time(row.at)}</span>;
  return (
    <span className="meta">
      {time(row.at)} {seen ? <><Checks size={14} weight="bold" className="seen" /> Seen</> : <><Check size={14} weight="bold" /> Sent</>}
    </span>
  );
}
