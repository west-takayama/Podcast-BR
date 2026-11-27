import { useState } from "react";
import { localSpeakerColor, type Speaker } from "../lib/video/speakers";

interface Props {
  speakers: Speaker[];
  localIds: string[];
  links: Record<string, string>;
  onName: (id: string, name: string) => void;
  onAdd: (localId?: string) => void;
  onLink: (localId: string, episodeId: string) => void;
  onSwap: (a: string, b: string) => void;
}

export default function SpeakerAssignments({ speakers, localIds, links, onName, onAdd, onLink, onSwap }: Props) {
  const [first, setFirst] = useState("");
  const [second, setSecond] = useState("");
  return (
    <details open className="fold speaker-assignments">
      <summary>話者名の一括設定</summary>
      <p className="muted">出演者名はこの回の候補で共有します。候補ごとにA・Bが別人の場合があるため、音声を聞いて対応を選びます。</p>
      {speakers.map((person, i) => (
        <label key={person.id} style={{ color: person.color }}>
          出演者 {i + 1}
          <input aria-label={`出演者 ${i + 1} の名前`} value={person.name} maxLength={24}
            onChange={e => onName(person.id, e.target.value)} />
        </label>
      ))}
      <button type="button" onClick={() => onAdd()}>出演者を追加</button>
      {localIds.map(id => (
        <div className="speaker-link" key={id}>
          <label style={{ color: speakers.find(person => person.id === links[id])?.color ?? localSpeakerColor(id) }}>
            この候補の話者 {id}
            <select aria-label={`話者 ${id} の割り当て`} value={links[id] ?? ""} onChange={e => onLink(id, e.target.value)}>
              <option value="">未割り当て</option>
              {speakers.map((person, i) => <option value={person.id} key={person.id}>{person.name.trim() || `出演者 ${i + 1}`}</option>)}
            </select>
          </label>
          {!links[id] && <button type="button" onClick={() => onAdd(id)}>{id}を新しい出演者に割り当て</button>}
        </div>
      ))}
      {speakers.length >= 2 && (
        <details className="fold">
          <summary>出演者名を入れ替える</summary>
          <div className="row-buttons">
            {[{ value: first, set: setFirst }, { value: second, set: setSecond }].map(({ value, set }, i) => (
              <select key={i} aria-label={`入れ替える出演者 ${i + 1}`} value={value} onChange={e => set(e.target.value)}>
                <option value="">選択</option>
                {speakers.map((person, j) => <option key={person.id} value={person.id}>{person.name.trim() || `出演者 ${j + 1}`}</option>)}
              </select>
            ))}
            <button type="button" disabled={!first || !second || first === second} onClick={() => onSwap(first, second)}>名前を入れ替える</button>
          </div>
        </details>
      )}
    </details>
  );
}
