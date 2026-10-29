import { choice, decide, noul } from '../../core/jev';
import { PersonRef } from '../../core/types';
import { PREDICATES } from './vocabulary';

// Query router: one Jev call maps a question to a subject entity and predicates, replacing the LLM
// query parse. Following the Jev experiments, "is there a specific subject?" is its own yes/no gate
// rather than a "none" option buried in the entity list.

export interface Route {
    subjects: string[];
    predicates: string[];
}

const PREDICATE_OPTIONS = Object.fromEntries(PREDICATES.map((p) => [p.name, p.description]));

export async function routeQuery(
    question: string,
    asker: PersonRef,
    people: PersonRef[],
    entities: { name: string; kind: string }[]
): Promise<Route> {
    // Option keys are short ids; Jev sees names and kinds in the descriptions.
    const subjects = [
        ...people.map((p) => ({ name: p.name, label: `${p.name} (person${p.aliases.length ? `; also ${p.aliases.join(', ')}` : ''})` })),
        ...entities.filter((e) => !people.some((p) => p.name === e.name)).map((e) => ({ name: e.name, label: `${e.name} (${e.kind})` })),
    ];
    const subjectOptions = Object.fromEntries(subjects.map((s, i) => [`s${i}`, s.label]));

    const answers = await decide(
        { question, asker: asker.name },
        {
            has_subject: noul(
                'Is the question about one specific person, team, project, client, service or deliverable? ("I", "me", "my" refer to the asker.)',
                'Yes: it names or clearly refers to one specific thing.',
                'No: it is general or names nothing specific.'
            ),
            subject: choice('Which one is the question about? ("I", "me", "my" refer to the asker.)', subjectOptions),
            predicate: choice('Which kind of fact would answer the question?', PREDICATE_OPTIONS),
        }
    );

    const route: Route = { subjects: [], predicates: [] };
    if (answers.has_subject.noul >= 0.5) {
        // Keep the runner-up too when Jev is torn between two subjects.
        const ranked = Object.entries(answers.subject.probabilities).sort((a, b) => b[1] - a[1]);
        for (const [key, p] of ranked.slice(0, 2)) {
            const subject = subjects[Number(key.slice(1))];
            if (subject && (p >= 0.25 || key === answers.subject.choice)) route.subjects.push(subject.name);
        }
    }
    route.predicates = Object.entries(answers.predicate.probabilities)
        .filter(([key, p]) => p >= 0.2 || key === answers.predicate.choice)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([key]) => key);
    return route;
}
