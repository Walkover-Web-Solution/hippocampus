import jwt from 'jsonwebtoken';

process.env.MEMORY_SIGNERS = JSON.stringify({ viasocket: 'test-secret-for-viasocket', other: 'another-secret' });
process.env.MEMORY_DATABASE_URL = process.env.MEMORY_DATABASE_URL || 'postgres://unused';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Grants, signMemoryToken, verifyMemoryToken } = require('../auth');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ApiError } = require('../../error/api-error');

const base = { issuer: 'viasocket', secret: 'test-secret-for-viasocket', orgId: '4310', projectId: 'projX', caller: 'users/maya' };

describe('memory grants', () => {
    it('reads a grants claim and refuses a bad one', () => {
        const grants = Grants.parse({ 'users/maya': 'write', 'teams/acme': 'write', 'product-truth': 'read', 'customers/*': 'read' });
        expect(grants.can('users/maya', 'write')).toBe(true);
        expect(grants.can('product-truth', 'read')).toBe(true);
        expect(grants.can('product-truth', 'write')).toBe(false);
        expect(grants.can('customers/acme', 'read')).toBe(true);
        expect(grants.can('customers/acme', 'write')).toBe(false);
        expect(grants.can('users/other', 'read')).toBe(false);
        expect(grants.patternsWith('write')).toEqual(['users/maya', 'teams/acme']);
        expect(() => Grants.parse({ 'users/maya': 'admin' })).toThrow(ApiError);
        expect(() => Grants.parse({ 'bad name': 'read' })).toThrow(ApiError);
        expect(() => Grants.parse(['users/maya'])).toThrow(ApiError);
        expect(Grants.parse(undefined).patterns).toEqual([]);
    });

    it('lets the most specific grant decide', () => {
        const grants = Grants.parse({ 'customers/*': 'read', 'customers/acme': 'write', '*': 'read' });
        expect(grants.accessTo('customers/acme')).toBe('write');
        expect(grants.accessTo('customers/bloom')).toBe('read');
        expect(grants.accessTo('anything')).toBe('read');
        expect(() => grants.require('customers/bloom', 'write')).toThrow(/cannot write/);
        expect(grants.require('customers/acme', 'write')).toBe('customers/acme');
    });
});

describe('memory tokens', () => {
    it('signs and verifies a token for a known signer', async () => {
        const token = signMemoryToken({ ...base, spaces: { 'users/maya': 'write', 'teams/acme': 'read' }, expiresIn: '10m' });
        const auth = await verifyMemoryToken(`Bearer ${token}`);
        expect(auth.tenant).toEqual({ issuer: 'viasocket', orgId: '4310', projectId: 'projX' });
        expect(auth.caller).toBe('users/maya');
        expect(auth.grants.can('teams/acme', 'read')).toBe(true);
        expect(auth.grants.can('teams/acme', 'write')).toBe(false);
    });

    it('accepts org_id and project_id as claim names and defaults the caller to the issuer', async () => {
        const token = jwt.sign({ org_id: '1', project_id: 'p', spaces: {} }, 'another-secret', { algorithm: 'HS256', issuer: 'other', expiresIn: '1m' });
        const auth = await verifyMemoryToken(token);
        expect(auth.tenant).toEqual({ issuer: 'other', orgId: '1', projectId: 'p' });
        expect(auth.caller).toBe('other');
    });

    it('refuses the wrong secret, an unknown issuer, no expiry, and an expired token', async () => {
        const wrong = jwt.sign({ org: '4310', project: 'p', spaces: {} }, 'not-the-secret', { algorithm: 'HS256', issuer: 'viasocket', expiresIn: '1m' });
        await expect(verifyMemoryToken(wrong)).rejects.toThrow(/Invalid memory token/);
        const unknown = jwt.sign({ org: '4310', project: 'p', spaces: {} }, 'x', { algorithm: 'HS256', issuer: 'nobody', expiresIn: '1m' });
        await expect(verifyMemoryToken(unknown)).rejects.toThrow(/Unknown memory token issuer/);
        const noExpiry = jwt.sign({ org: '4310', project: 'p', spaces: {} }, 'test-secret-for-viasocket', { algorithm: 'HS256', issuer: 'viasocket' });
        await expect(verifyMemoryToken(noExpiry)).rejects.toThrow(/expiry/);
        const expired = jwt.sign({ org: '4310', project: 'p', spaces: {} }, 'test-secret-for-viasocket', { algorithm: 'HS256', issuer: 'viasocket', expiresIn: -10 });
        await expect(verifyMemoryToken(expired)).rejects.toThrow(/expired/);
        await expect(verifyMemoryToken(undefined)).rejects.toThrow(/Missing/);
        const noTenant = jwt.sign({ spaces: {} }, 'test-secret-for-viasocket', { algorithm: 'HS256', issuer: 'viasocket', expiresIn: '1m' });
        await expect(verifyMemoryToken(noTenant)).rejects.toThrow(/org and project/);
    });

    it('never accepts an unsigned token', async () => {
        const none = jwt.sign({ org: '4310', project: 'p', spaces: {} }, '', { algorithm: 'none', issuer: 'viasocket', expiresIn: '1m' });
        await expect(verifyMemoryToken(none)).rejects.toThrow(ApiError);
    });
});
