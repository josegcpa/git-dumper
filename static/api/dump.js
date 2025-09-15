// Provider-agnostic API handler for /api/dump
// Works in many environments:
// - Node/Express/Serverless (default export handler(req, res))
// - Fetch-based runtimes (export async function fetch(request))

import { dumpRepoHeadless } from '../lib.js';

function corsHeaders(origin = '*') {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

async function runDump(body) {
  const {
    owner,
    repo,
    branch = null,
    regex = null,
    ignoreCommon = true,
    maxSizeKB = 1024,
    extraIgnores = [],
  } = body || {};

  if (!owner || !repo) {
    return { status: 400, text: 'owner and repo are required' };
  }

  const controller = new AbortController();
  const token = (typeof process !== 'undefined' && process?.env?.GITHUB_TOKEN) ? process.env.GITHUB_TOKEN : null;

  const { text } = await dumpRepoHeadless({
    owner,
    repo,
    branch,
    regex,
    token,
    signal: controller.signal,
    maxBytes: (Number.isFinite(+maxSizeKB) ? +maxSizeKB : 1024) * 1024,
    ignoreCommon: !!ignoreCommon,
    extraIgnores: Array.isArray(extraIgnores) ? extraIgnores : [],
  });

  return { status: 200, text: text || '' };
}

// Default Node-style handler (e.g., Vercel/Netlify/Express adapters)
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    Object.entries(corsHeaders('*')).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(204).end();
  }
  if (req.method !== 'POST') return res.status(405).end('Method Not Allowed');

  try {
    const body = typeof req.body === 'object' && req.body ? req.body : JSON.parse(req.body || '{}');
    const result = await runDump(body);
    Object.entries({ 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders('*') }).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(result.status).send(result.text);
  } catch (e) {
    return res.status(500).send(`Error: ${e.message}`);
  }
}

export async function fetch(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders('*') });
  }
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: corsHeaders('*') });
  }
  try {
    const body = await request.json();
    const result = await runDump(body);
    return new Response(result.text, {
      status: result.status,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders('*') },
    });
  } catch (e) {
    return new Response(`Error: ${e.message}`, { status: 500, headers: corsHeaders('*') });
  }
}
