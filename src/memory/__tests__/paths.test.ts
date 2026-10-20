import { ApiError } from '../../error/api-error';
import {
    folderOf, generatedPath, grantCovers, grantSpecificity, isGrantPattern, normalizeKind, normalizePath, normalizeSpace, slugify,
} from '../paths';

describe('memory paths', () => {
    it('accepts folder-like space names and cleans slashes', () => {
        expect(normalizeSpace('users/maya')).toBe('users/maya');
        expect(normalizeSpace('/teams//acme/')).toBe('teams/acme');
        expect(normalizeSpace('customers/bloom.com')).toBe('customers/bloom.com');
        expect(normalizeSpace('agents/writer@v2')).toBe('agents/writer@v2');
    });

    it('rejects empty segments, spaces and odd characters', () => {
        for (const bad of ['', '/', 'has space', 'a/*', 'me me', '-leading', 'a\\b', 'a/.b']) {
            expect(() => normalizeSpace(bad)).toThrow(ApiError);
        }
        expect(() => normalizePath('')).toThrow(ApiError);
        expect(() => normalizePath('x'.repeat(301))).toThrow(ApiError);
        expect(normalizePath('drafts/launch-email')).toBe('drafts/launch-email');
    });

    it('normalises kinds to short lowercase words', () => {
        expect(normalizeKind(undefined)).toBe('note');
        expect(normalizeKind(' Rule ')).toBe('rule');
        expect(normalizeKind('my_kind-2')).toBe('my_kind-2');
        expect(() => normalizeKind('Not A Kind')).toThrow(ApiError);
    });

    it('matches grant patterns exactly, by folder, or everything', () => {
        expect(isGrantPattern('*')).toBe(true);
        expect(isGrantPattern('customers/*')).toBe(true);
        expect(isGrantPattern('customers/*/x')).toBe(false);
        expect(grantCovers('*', 'anything/at/all')).toBe(true);
        expect(grantCovers('customers/*', 'customers/acme')).toBe(true);
        expect(grantCovers('customers/*', 'customers/acme/notes')).toBe(true);
        expect(grantCovers('customers/*', 'customers')).toBe(false);
        expect(grantCovers('customers/*', 'customers-old/acme')).toBe(false);
        expect(grantCovers('product-truth', 'product-truth')).toBe(true);
        expect(grantCovers('product-truth', 'product-truth/x')).toBe(false);
    });

    it('ranks an exact grant above a folder above everything', () => {
        expect(grantSpecificity('customers/acme')).toBeGreaterThan(grantSpecificity('customers/*'));
        expect(grantSpecificity('customers/eu/*')).toBeGreaterThan(grantSpecificity('customers/*'));
        expect(grantSpecificity('customers/*')).toBeGreaterThan(grantSpecificity('*'));
    });

    it('makes stable paths from text', () => {
        expect(slugify('Runs marketing at Acme Inc.')).toBe('runs-marketing-at-acme-inc');
        expect(generatedPath('fact', 'Runs marketing at Acme.')).toMatch(/^facts\/runs-marketing-at-acme-[0-9a-f]{4}$/);
        expect(generatedPath('fact', '!!!')).toMatch(/^facts\/note-[0-9a-f]{4}$/);
        expect(folderOf('drafts/launch-email')).toBe('drafts');
        expect(folderOf('pricing')).toBe('');
    });
});
