import type { CaptionCue, DisplayCue } from "./captionAlignment";

export interface Speaker { id: string; name: string; color: string }
const palette = ["#8de9ff", "#ffbcdf", "#bbf5a2", "#ffd580", "#d8c1ff", "#ffa495", "#91e5c5", "#dde786"];

export function addSpeaker(people: Speaker[]): Speaker[] {
  const number = people.length + 1;
  return [...people, { id: `person-${number}`, name: "", color: palette[(number - 1) % palette.length] }];
}

export function localSpeakerColor(id: string): string {
  const hash = [...id].reduce((code, char) => (31 * code + char.charCodeAt(0)) >>> 0, 0);
  return palette[hash % palette.length];
}

export function swapSpeakerNames(people: Speaker[], first: string, second: string): Speaker[] {
  const a = people.find(person => person.id === first);
  const b = people.find(person => person.id === second);
  if (!a || !b || a === b) return people;
  return people.map(person => person === a ? { ...person, name: b.name } : person === b ? { ...person, name: a.name } : person);
}

export function displayCues(cues: CaptionCue[], people: Speaker[], links: Record<string, string>, durationMs: number): DisplayCue[] {
  return cues.flatMap(cue => {
    if (cue.startMs === null || cue.endMs === null || cue.startMs < 0 || cue.startMs >= cue.endMs || cue.endMs > durationMs || !cue.text.trim()) return [];
    const person = people.find(item => item.id === (cue.personOverride ?? links[cue.speakerId]));
    return [{
      atSec: cue.startMs / 1000,
      endSec: cue.endMs / 1000,
      speaker: person?.name.trim() || cue.speakerId,
      speakerColor: person?.color ?? localSpeakerColor(cue.speakerId),
      text: cue.text,
      emphasis: cue.emphasis.filter(word => cue.text.includes(word)),
    }];
  });
}
