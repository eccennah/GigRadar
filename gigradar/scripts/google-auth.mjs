// One-time Google sign-in for the Lifecycle Agent. Run it on your own computer:
//
//   node scripts/google-auth.mjs
//
// It reads the OAuth client you downloaded from Google Cloud (../google-oauth-client.json), opens your browser so you can
// approve Gmail (read-only) and Calendar (events) access, then writes GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and
// GOOGLE_REFRESH_TOKEN into this folder's .env file. Nothing secret is printed.
//
// Apps in "Testing" mode get refresh tokens that expire after 7 days: run this again before your demo.
import { exec } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientFile = [
    path.join(here, '..', '..', 'google-oauth-client.json'),
    path.join(here, '..', 'google-oauth-client.json'),
].find((f) => fs.existsSync(f));
if (!clientFile) {
    console.error(
        'Could not find google-oauth-client.json. Save the OAuth client JSON from Google Cloud in the GigRadar folder.',
    );
    process.exit(1);
}
const client = JSON.parse(fs.readFileSync(clientFile, 'utf8'));
const { client_id: clientId, client_secret: clientSecret } = client.installed ?? client.web ?? {};
if (!clientId || !clientSecret) {
    console.error('google-oauth-client.json does not look like a Desktop app OAuth client.');
    process.exit(1);
}

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/calendar.events'];

const server = http.createServer();
server.listen(0, '127.0.0.1', () => {
    const redirectUri = `http://127.0.0.1:${server.address().port}`;
    const url = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: SCOPES.join(' '),
        access_type: 'offline',
        prompt: 'consent',
    })}`;
    console.log('Opening your browser to sign in to Google. If it does not open, paste this link into your browser:\n');
    console.log(url, '\n');
    const opener =
        process.platform === 'win32'
            ? `start "" "${url}"`
            : process.platform === 'darwin'
              ? `open "${url}"`
              : `xdg-open "${url}"`;
    exec(opener);

    server.on('request', async (req, res) => {
        const params = new URL(req.url, redirectUri).searchParams;
        const code = params.get('code');
        if (!code) {
            res.end(params.get('error') ? `Sign-in cancelled: ${params.get('error')}` : 'Waiting for Google...');
            return;
        }
        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                code,
                client_id: clientId,
                client_secret: clientSecret,
                redirect_uri: redirectUri,
                grant_type: 'authorization_code',
            }),
        });
        const tokens = await tokenRes.json();
        if (!tokens.refresh_token) {
            res.end('Google did not return a refresh token. Close this tab and check the terminal.');
            console.error(
                'No refresh token received:',
                tokens.error ?? 'unknown error',
                tokens.error_description ?? '',
            );
            server.close();
            return;
        }

        const envFile = path.join(here, '..', '.env');
        const existing = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
        const kept = existing
            .split(/\r?\n/)
            .filter((l) => l && !/^GOOGLE_(CLIENT_ID|CLIENT_SECRET|REFRESH_TOKEN)=/.test(l));
        kept.push(
            `GOOGLE_CLIENT_ID=${clientId}`,
            `GOOGLE_CLIENT_SECRET=${clientSecret}`,
            `GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`,
        );
        fs.writeFileSync(envFile, `${kept.join('\n')}\n`);

        res.end('Done! GigRadar can now read your Gmail and add interviews to your calendar. You can close this tab.');
        console.log(`Saved GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN to ${envFile}`);
        server.close();
    });
});
