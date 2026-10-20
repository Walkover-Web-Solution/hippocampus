import { randomBytes } from 'crypto';
import { ApiError } from '../error/api-error';

/**
 * Names in the file system. A space is a folder name such as "users/maya", "teams/acme" or "product-truth"; a path
 * is a file name inside it such as "pricing" or "drafts/launch-email". Both are segments of letters, digits and
 * _ . @ - joined by "/", with no empty segments. A grant pattern is a space name, or a folder with "/*" to mean
 * everything under it, or "*" for every space.
 */
const SEGMENT = '[A-Za-z0-9][A-Za-z0-9_.@-]*';
export const NAME_PATTERN = new RegExp(`^${SEGMENT}(?:/${SEGMENT})*$`);
export const GRANT_PATTERN = new RegExp(`^(?:\\*|${SEGMENT}(?:/${SEGMENT})*(?:/\\*)?)$`);
export const MAX_SPACE_LENGTH = 200;
export const MAX_PATH_LENGTH = 300;
export const MAX_KIND_LENGTH = 32;
export const KIND_PATTERN = /^[a-z][a-z0-9_-]*$/;

const clean = (value: string): string => value.trim().replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '');

export const isSpaceName = (value: unknown): value is string => typeof value === 'string' && value.length <= MAX_SPACE_LENGTH && NAME_PATTERN.test(value);

export const normalizeSpace = (value: unknown): string => {
    const name = typeof value === 'string' ? clean(value) : '';
    if (!isSpaceName(name)) throw new ApiError(`Invalid space name "${String(value)}": use segments of letters, digits and _ . @ - joined by "/"`, 400);
    return name;
};

export const normalizePath = (value: unknown): string => {
    const path = typeof value === 'string' ? clean(value) : '';
    if (!path || path.length > MAX_PATH_LENGTH || !NAME_PATTERN.test(path)) {
        throw new ApiError(`Invalid note path "${String(value)}": use segments of letters, digits and _ . @ - joined by "/"`, 400);
    }
    return path;
};

export const normalizeKind = (value: unknown): string => {
    const kind = typeof value === 'string' ? value.trim().toLowerCase() : 'note';
    if (!kind) return 'note';
    if (kind.length > MAX_KIND_LENGTH || !KIND_PATTERN.test(kind)) throw new ApiError(`Invalid kind "${String(value)}": a short lowercase word`, 400);
    return kind;
};

export const isGrantPattern = (value: unknown): value is string => typeof value === 'string' && value.length <= MAX_SPACE_LENGTH + 2 && GRANT_PATTERN.test(value);

// Whether a grant pattern covers a space: exactly, or as a folder above it. "customers/*" covers "customers/acme"
// and "customers/acme/notes" but not "customers" itself.
export const grantCovers = (pattern: string, space: string): boolean => {
    if (pattern === '*') return true;
    if (pattern.endsWith('/*')) return space.startsWith(pattern.slice(0, -1));
    return pattern === space;
};

// How specific a pattern is, so the most specific grant for a space wins: an exact name beats a folder, a deeper
// folder beats a shallower one, "*" is the least specific.
export const grantSpecificity = (pattern: string): number => {
    if (pattern === '*') return 0;
    if (pattern.endsWith('/*')) return 1 + pattern.split('/').length;
    return 1000 + pattern.split('/').length;
};

// A pattern as a SQL condition on a name column.
export const grantCondition = (pattern: string, column: string, param: (value: unknown) => string): string => {
    if (pattern === '*') return 'TRUE';
    if (pattern.endsWith('/*')) return `${column} LIKE ${param(`${pattern.slice(0, -1).replace(/[\\%_]/g, (char) => `\\${char}`)}%`)}`;
    return `${column} = ${param(pattern)}`;
};

export const slugify = (text: string, max = 48): string => text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');

// A path for a note saved without one: its kind as the folder, a slug of its text and a few random characters so
// two notes that start the same way never collide. "facts/runs-marketing-at-acme-3f2a".
export const generatedPath = (kind: string, text: string): string => {
    const slug = slugify(text) || 'note';
    return `${kind}s/${slug}-${randomBytes(2).toString('hex')}`;
};

// The folder a path sits in, or "" at the root.
export const folderOf = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
