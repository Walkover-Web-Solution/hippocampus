// OAuth sign-in for apps that connect to the memory server by URL only (claude.ai, ChatGPT, Gemini
// Enterprise): an organisation adds the server once, and each person signs in with Google. The verified
// Google email must be on the roster (world.json), and the token then acts as that person. The server is
// its own authorization server; the SDK's handlers do the protocol (PKCE, registration, token requests)
// and this provider does the rest. Tokens and registered clients are kept in a file, tokens as hashes.

import { createHash, randomBytes } from 'crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs';
import express, { Express, Response } from 'express';
import { authorizationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import { clientRegistrationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/register.js';
import { revocationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/revoke.js';
import { tokenHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/token.js';
import { InvalidGrantError, InvalidTargetError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { World } from './service';

const CODE_TTL_MS = 60_000;
const SIGN_IN_TTL_MS = 10 * 60_000;
const ACCESS_TTL_MS = 60 * 60_000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60_000;
const SCOPES = ['memory'];

export interface GoogleIdentity {
    email: string;
    emailVerified: boolean;
}
export type GoogleExchange = (code: string, redirectUri: string) => Promise<GoogleIdentity>;

interface Grant {
    personId: string;
    clientId: string;
    resource: string;
    scopes: string[];
    issuedAt: number;
    expiresAt: number;
}
interface StoreData {
    clients: Record<string, OAuthClientInformationFull>;
    access: Record<string, Grant>;
    refresh: Record<string, Grant>;
    // Sign-outs: tokens a person got before this time no longer work.
    revokedBefore: Record<string, number>;
}
// A sign-in in progress: started by an app, waiting for Google and then for the person's consent.
interface SignIn {
    client: OAuthClientInformationFull;
    params: AuthorizationParams;
    resource: string;
    startedAt: number;
    person?: { id: string; name: string; email: string };
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export interface TeamOAuthOptions {
    // The public address of the memory server, e.g. https://hippocampus.gtwy.ai/memory. It is the issuer,
    // and tokens are only for resources under it.
    issuer: string;
    file: string;
    world: () => World;
    google: { clientId: string; clientSecret: string };
    exchangeGoogle?: GoogleExchange;
    now?: () => number;
}

export class TeamOAuth implements OAuthServerProvider {
    readonly issuer: string;
    private signIns = new Map<string, SignIn>();
    private codes = new Map<string, Grant & { codeChallenge: string; redirectUri: string }>();
    private now: () => number;
    private exchangeGoogle: GoogleExchange;

    constructor(private options: TeamOAuthOptions) {
        this.issuer = options.issuer.replace(/\/+$/, '');
        this.now = options.now ?? Date.now;
        this.exchangeGoogle = options.exchangeGoogle ?? ((code, redirectUri) => googleIdentity(code, redirectUri, options.google));
    }

    // ---- storage ----
    private read(): StoreData {
        const empty: StoreData = { clients: {}, access: {}, refresh: {}, revokedBefore: {} };
        return existsSync(this.options.file) ? { ...empty, ...JSON.parse(readFileSync(this.options.file, 'utf8')) } : empty;
    }
    private write(data: StoreData) {
        const now = this.now();
        for (const kind of ['access', 'refresh'] as const) {
            for (const [hash, grant] of Object.entries(data[kind])) if (grant.expiresAt <= now) delete data[kind][hash];
        }
        const tmp = `${this.options.file}.tmp`;
        writeFileSync(tmp, JSON.stringify(data, null, 1), { mode: 0o600 });
        renameSync(tmp, this.options.file);
    }

    get clientsStore(): OAuthRegisteredClientsStore {
        return {
            getClient: (clientId) => this.read().clients[clientId],
            registerClient: (client) => {
                const data = this.read();
                const full = { ...client, client_id: randomBytes(16).toString('hex'), client_id_issued_at: Math.floor(this.now() / 1000) } as OAuthClientInformationFull;
                data.clients[full.client_id] = full;
                this.write(data);
                return full;
            },
        };
    }

    // A client with a fixed id and secret, for apps that don't register themselves (Gemini Enterprise).
    registerFixedClient(name: string, redirectUris: string[]): { client_id: string; client_secret: string } {
        const client_secret = secret();
        const full = this.clientsStore.registerClient!({
            client_name: name, redirect_uris: redirectUris, client_secret, client_secret_expires_at: 0,
            token_endpoint_auth_method: 'client_secret_post', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
        }) as OAuthClientInformationFull;
        return { client_id: full.client_id, client_secret };
    }

    // ---- sign-in: app → /authorize → Google → consent → app ----
    private ownResource(resource: URL | undefined): string {
        const href = (resource?.href ?? this.issuer).replace(/#.*$/, '').replace(/\/+$/, '');
        if (href !== this.issuer && !href.startsWith(`${this.issuer}/`)) throw new InvalidTargetError(`This server only issues tokens for ${this.issuer}`);
        return href;
    }

    get googleRedirectUri() {
        return `${this.issuer}/oauth/google/callback`;
    }

    async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
        const now = this.now();
        for (const [id, s] of this.signIns) if (now - s.startedAt > SIGN_IN_TTL_MS) this.signIns.delete(id);
        let resource: string;
        try {
            resource = this.ownResource(params.resource);
        } catch {
            res.redirect(this.appRedirect(params, { error: 'invalid_target', error_description: 'Unknown resource' }));
            return;
        }
        const id = secret();
        this.signIns.set(id, { client, params, resource, startedAt: now });
        const google = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        google.search = new URLSearchParams({
            client_id: this.options.google.clientId, redirect_uri: this.googleRedirectUri, response_type: 'code',
            scope: 'openid email', state: id, prompt: 'select_account',
        }).toString();
        res.redirect(google.href);
    }

    private appRedirect(params: AuthorizationParams, values: Record<string, string>): string {
        const url = new URL(params.redirectUri);
        for (const [k, v] of Object.entries(values)) url.searchParams.set(k, v);
        if (params.state !== undefined) url.searchParams.set('state', params.state);
        url.searchParams.set('iss', this.issuer);
        return url.href;
    }

    // Google sent the person back: check who they are and ask them to confirm.
    async googleCallback(query: Record<string, unknown>): Promise<{ status: number; html: string }> {
        const signIn = typeof query.state === 'string' ? this.signIns.get(query.state) : undefined;
        if (!signIn || this.now() - signIn.startedAt > SIGN_IN_TTL_MS) return page(400, 'Sign-in expired', 'Please start again from your app.');
        if (typeof query.code !== 'string') return page(400, 'Sign-in cancelled', 'Google sign-in did not complete. Please start again from your app.');
        let identity: GoogleIdentity;
        try {
            identity = await this.exchangeGoogle(query.code, this.googleRedirectUri);
        } catch {
            return page(502, 'Google sign-in failed', 'Please try again in a minute.');
        }
        const email = identity.email.trim().toLowerCase();
        const person = this.options.world().people.find((p) => p.email?.toLowerCase() === email);
        if (!identity.emailVerified || !person) {
            this.signIns.delete(query.state as string);
            return page(403, 'Not on the team yet', `${escapeHtml(email)} isn't on the Team Memory roster. Ask your admin to add this email, then try again.`);
        }
        signIn.person = { id: person.id, name: person.name, email };
        const app = escapeHtml(signIn.client.client_name ?? 'An app');
        const host = escapeHtml(new URL(signIn.params.redirectUri).host);
        return page(200, 'Allow access to Team Memory?', `<b>${app}</b> (${host}) wants to read and save memories as <b>${escapeHtml(person.name)}</b> (${escapeHtml(email)}), including your team's.`,
            `<form method="post" action="${this.issuer}/oauth/consent">
               <input type="hidden" name="signin" value="${escapeHtml(query.state as string)}">
               <button name="decision" value="allow">Allow</button>
               <button name="decision" value="deny" class="secondary">Cancel</button>
             </form>`);
    }

    // The person answered the consent page: send them back to the app with a code, or with a refusal.
    consent(body: Record<string, unknown>): { redirect: string } | { status: number; html: string } {
        const id = typeof body.signin === 'string' ? body.signin : '';
        const signIn = this.signIns.get(id);
        this.signIns.delete(id);
        if (!signIn?.person || this.now() - signIn.startedAt > SIGN_IN_TTL_MS) return page(400, 'Sign-in expired', 'Please start again from your app.');
        if (body.decision !== 'allow') return { redirect: this.appRedirect(signIn.params, { error: 'access_denied', error_description: 'The person declined' }) };
        const code = secret();
        const now = this.now();
        this.codes.set(sha256(code), {
            personId: signIn.person.id, clientId: signIn.client.client_id, resource: signIn.resource, scopes: SCOPES,
            issuedAt: now, expiresAt: now + CODE_TTL_MS, codeChallenge: signIn.params.codeChallenge, redirectUri: signIn.params.redirectUri,
        });
        return { redirect: this.appRedirect(signIn.params, { code }) };
    }

    // ---- token endpoint ----
    private liveCode(client: OAuthClientInformationFull, code: string) {
        const grant = this.codes.get(sha256(code));
        if (!grant || grant.clientId !== client.client_id || grant.expiresAt <= this.now()) throw new InvalidGrantError('Invalid or expired authorization code');
        return grant;
    }

    async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
        return this.liveCode(client, code).codeChallenge;
    }

    async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, _verifier?: string, redirectUri?: string, resource?: URL): Promise<OAuthTokens> {
        const grant = this.liveCode(client, code);
        this.codes.delete(sha256(code));
        if (redirectUri && redirectUri !== grant.redirectUri) throw new InvalidGrantError('redirect_uri does not match');
        if (resource && this.ownResource(resource) !== grant.resource) throw new InvalidTargetError('resource does not match the sign-in');
        return this.issueTokens(grant.personId, client.client_id, grant.resource);
    }

    async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, _scopes?: string[], resource?: URL): Promise<OAuthTokens> {
        const data = this.read();
        const hash = sha256(refreshToken);
        const grant = data.refresh[hash];
        if (!grant || grant.clientId !== client.client_id || !this.stillValid(grant, data)) throw new InvalidGrantError('Invalid or expired refresh token');
        if (resource && this.ownResource(resource) !== grant.resource) throw new InvalidTargetError('resource does not match the sign-in');
        // Each refresh token works once; the response carries its replacement.
        delete data.refresh[hash];
        this.write(data);
        return this.issueTokens(grant.personId, client.client_id, grant.resource);
    }

    private stillValid(grant: Grant, data: StoreData): boolean {
        if (grant.expiresAt <= this.now()) return false;
        if ((data.revokedBefore[grant.personId] ?? 0) >= grant.issuedAt) return false;
        return this.options.world().people.some((p) => p.id === grant.personId);
    }

    private issueTokens(personId: string, clientId: string, resource: string): OAuthTokens {
        const data = this.read();
        const now = this.now();
        const access = secret();
        const refresh = secret();
        const grant = { personId, clientId, resource, scopes: SCOPES, issuedAt: now };
        data.access[sha256(access)] = { ...grant, expiresAt: now + ACCESS_TTL_MS };
        data.refresh[sha256(refresh)] = { ...grant, expiresAt: now + REFRESH_TTL_MS };
        this.write(data);
        return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_MS / 1000, refresh_token: refresh, scope: SCOPES.join(' ') };
    }

    async verifyAccessToken(token: string): Promise<AuthInfo> {
        const data = this.read();
        const grant = data.access[sha256(token)];
        if (!grant || !this.stillValid(grant, data)) throw new InvalidTokenError('Invalid or expired access token');
        return { token, clientId: grant.clientId, scopes: grant.scopes, expiresAt: Math.floor(grant.expiresAt / 1000), resource: new URL(grant.resource), extra: { personId: grant.personId } };
    }

    // The person an access token acts for, when it was issued for this resource (or for the whole server).
    async personFor(token: string | undefined, resource: string): Promise<string | undefined> {
        if (!token) return undefined;
        try {
            const info = await this.verifyAccessToken(token);
            const granted = info.resource!.href.replace(/\/+$/, '');
            return granted === this.issuer || granted === resource.replace(/\/+$/, '') ? (info.extra!.personId as string) : undefined;
        } catch {
            return undefined;
        }
    }

    async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
        const data = this.read();
        const hash = sha256(request.token);
        delete data.access[hash];
        delete data.refresh[hash];
        this.write(data);
    }

    // Signs the person out of every app at once.
    revokePerson(personId: string) {
        const data = this.read();
        data.revokedBefore[personId] = this.now();
        this.write(data);
    }

    // ---- discovery ----
    serverMetadata() {
        return {
            issuer: this.issuer,
            authorization_endpoint: `${this.issuer}/authorize`,
            token_endpoint: `${this.issuer}/token`,
            registration_endpoint: `${this.issuer}/register`,
            revocation_endpoint: `${this.issuer}/revoke`,
            response_types_supported: ['code'],
            grant_types_supported: ['authorization_code', 'refresh_token'],
            code_challenge_methods_supported: ['S256'],
            token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
            revocation_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
            scopes_supported: SCOPES,
            authorization_response_iss_parameter_supported: true,
        };
    }

    resourceMetadata(path: string) {
        return {
            resource: `${this.issuer}${path}`.replace(/\/+$/, ''),
            authorization_servers: [this.issuer],
            scopes_supported: SCOPES,
            bearer_methods_supported: ['header'],
            resource_name: 'Team Memory',
        };
    }

    resourceMetadataUrl(path: string) {
        return `${this.issuer}/.well-known/oauth-protected-resource${path}`;
    }
}

// Exchanges Google's code for the person's verified email. The ID token comes straight from Google's token
// endpoint over TLS with our client secret, so its claims are checked but its signature needn't be.
async function googleIdentity(code: string, redirectUri: string, google: { clientId: string; clientSecret: string }): Promise<GoogleIdentity> {
    const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code, client_id: google.clientId, client_secret: google.clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
        signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Google token exchange failed: HTTP ${res.status}`);
    const { id_token } = (await res.json()) as { id_token?: string };
    const claims = JSON.parse(Buffer.from(String(id_token).split('.')[1] ?? '', 'base64url').toString('utf8'));
    if (claims.aud !== google.clientId || !['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss) || claims.exp * 1000 < Date.now()) {
        throw new Error('Unexpected Google ID token');
    }
    return { email: String(claims.email ?? ''), emailVerified: claims.email_verified === true };
}

function page(status: number, title: string, message: string, extra = ''): { status: number; html: string } {
    return {
        status,
        html: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;background:#f6f5f2;color:#222;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}
main{background:#fff;max-width:420px;padding:28px;border-radius:12px;box-shadow:0 1px 4px #0002}h1{font-size:20px;margin:0 0 12px}
button{font:inherit;padding:8px 18px;border-radius:8px;border:0;background:#222;color:#fff;margin:16px 8px 0 0;cursor:pointer}button.secondary{background:#e7e5e0;color:#222}</style>
</head><body><main><h1>${escapeHtml(title)}</h1><p>${message}</p>${extra}</main></body></html>`,
    };
}

// Endpoints, mounted at the app root (nginx strips /memory). Discovery is served here, and nginx routes the
// root-level well-known paths for this issuer here too.
export function mountOAuth(app: Express, oauth: TeamOAuth) {
    const serverMetadata = (_req: express.Request, res: express.Response) => res.set('Access-Control-Allow-Origin', '*').json(oauth.serverMetadata());
    app.get(['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/memory', '/.well-known/openid-configuration'], serverMetadata);
    app.get(/^\/\.well-known\/oauth-protected-resource(\/.*)?$/, (req, res) => {
        res.set('Access-Control-Allow-Origin', '*').json(oauth.resourceMetadata((req.params as Record<string, string>)[0] ?? ''));
    });
    app.use('/authorize', authorizationHandler({ provider: oauth, rateLimit: false }));
    app.use('/token', tokenHandler({ provider: oauth, rateLimit: false }));
    app.use('/register', clientRegistrationHandler({ clientsStore: oauth.clientsStore, rateLimit: { windowMs: 60 * 60_000, max: 200 } }));
    app.use('/revoke', revocationHandler({ provider: oauth, rateLimit: false }));
    const send = (res: express.Response, out: { redirect: string } | { status: number; html: string }) => {
        res.set('X-Frame-Options', 'DENY').set('Cache-Control', 'no-store');
        if ('redirect' in out) res.redirect(out.redirect);
        else res.status(out.status).type('html').send(out.html);
    };
    app.get('/oauth/google/callback', async (req, res) => send(res, await oauth.googleCallback(req.query)));
    app.post('/oauth/consent', express.urlencoded({ extended: false }), (req, res) => send(res, oauth.consent(req.body)));
}
