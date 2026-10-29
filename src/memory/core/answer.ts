import { text } from './llm';
import { PersonRef, RecalledMemory } from './types';

const SYSTEM = `You answer a user's question using ONLY the memories provided.
Rules:
- Memories marked "current" are what is believed now. "superseded" memories were true before and were replaced; use them only for questions about the past.
- "proposed" memories are unconfirmed; mention them only as unconfirmed. "disputed" memories conflict; say there is a conflict and list the values.
- If memories disagree and none is marked superseded, prefer the most recent one and say that it replaced the older one.
- People may be referred to by name, nickname or email; use the people list to match them. "I", "me", "my" refer to the asker.
- If the memories do not contain the answer, reply exactly: I don't know.
- Answer in one or two short sentences. Do not invent anything.`;

// For people using the memory (the Memory Lab): partial and related answers instead of a flat "I don't know".
// The eval keeps SYSTEM, so scores stay comparable.
const HELPFUL_SYSTEM = `You answer a teammate's question from the memories provided (what their apps remembered about them and their team).
Rules:
- Use only the memories; never invent facts.
- "current" memories are believed now; "superseded" ones were true before (mention them only as history); "proposed" ones are unconfirmed (say so); "disputed" ones conflict (say so and list the values). A memory valid until a time that has passed is no longer true.
- If the memories answer only part of the question, answer that part and say what isn't known.
- If they don't answer it but hold something clearly related (someone working on the same area, a recent change to it), say what is related and that it may be the reason or the person to ask.
- For "how many" or "who all" questions, count or list what the memories show and say the list may be incomplete.
- Only when nothing relevant is there, reply: I don't know.
- People may be referred to by name, nickname, email or with a small typo; use the people list. "I", "me", "my" refer to the asker.
- Two or three short sentences.`;

export function formatMemories(memories: RecalledMemory[]): string {
    if (memories.length === 0) return '(no memories)';
    return memories
        .map((m) => {
            const validity = m.validFrom || m.validTo ? ` valid ${m.validFrom ?? '?'} → ${m.validTo ?? 'now'}` : '';
            const author = m.author ? ` (stated by ${m.author})` : '';
            return `- [${m.scope}] [${m.status}${validity}] ${m.text}${author}`;
        })
        .join('\n');
}

// Shared answerer: same prompt, model and context (people directory, asker) for every approach, so
// answer quality reflects what the approach recalled, not how it phrased things.
export async function answer(
    question: string,
    memories: RecalledMemory[],
    now: string,
    asOf: string | null,
    asker: PersonRef,
    people: PersonRef[],
    mode: 'strict' | 'helpful' = 'strict'
): Promise<string> {
    const timeLine = asOf ? `The question is about the state as of ${asOf}.` : `Current time: ${now}.`;
    const directory = people.map((p) => `- ${p.name}${p.aliases.length ? ` (also: ${p.aliases.join(', ')})` : ''}`).join('\n');
    const user = `${timeLine}\nAsker: ${asker.name}\n\nPeople:\n${directory}\n\nMemories:\n${formatMemories(memories)}\n\nQuestion: ${question}`;
    return (await text(mode === 'helpful' ? HELPFUL_SYSTEM : SYSTEM, user)).trim();
}
