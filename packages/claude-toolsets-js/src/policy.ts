/**
 * URL checks: the example URL policy (a port of the quickstart's, with optional ports), and the driver's own checks,
 * which apply whether or not a policy is set: only http(s) and the empty tab open, and the sandbox's DevTools and
 * envd ports are never reachable from a page.
 */

import { ToolError, type BetaURLPolicy } from '@anthropic-ai/sdk/helpers/beta/toolsets';

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const HOST_PORT = /^[^:/?#]+:\d+(?:[/?#]|$)/;

/**
 * The address the browser will open: `https://` added when none is written. `localhost:8000/x` is a host and port,
 * not a `localhost:` scheme. Used by `navigate` and by `examplePolicy`, so both read an address the same way.
 */
export function withDefaultScheme(url: string): string {
  return HAS_SCHEME.test(url) && !HOST_PORT.test(url) ? url : `https://${url}`;
}

/**
 * Throw a `ToolError` for a URL that is not http, https or `about:blank` (with an optional `#fragment`): other
 * schemes run script, read local files or reach browser internals. The URL is read the way a browser reads an
 * address: leading spaces and control characters dropped, tabs and line breaks removed anywhere (so `java\nscript:`
 * is `javascript:`), letter case ignored. A URL without a scheme passes; `navigate` adds `https://` to it first.
 */
export function refuseScheme(url: string): void {
  const read = url.replace(/[\t\n\r]/g, '').replace(/^[\u0000- ]+/, '');
  if (HOST_PORT.test(read)) return; // `localhost:8000/x` is a host and port, not a scheme
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(read)?.[1]?.toLowerCase();
  if (scheme === undefined || scheme === 'http' || scheme === 'https') return;
  if (scheme === 'about' && /^about:blank(#.*)?$/is.test(read)) return;
  throw new ToolError(`The ${scheme}: scheme is not allowed. Navigate to an http or https URL.`);
}

/** Ports on the sandbox's local addresses a page never reaches: Chrome's DevTools endpoint, E2B's envd and the
 * desktop's noVNC stream (`liveView`), which would hand a page the whole desktop. Same set as the Python driver. */
const RESERVED_LOCAL_PORTS: ReadonlySet<string> = new Set(['9222', '49983', '6080']);

/**
 * Fetch URL patterns (`*` wildcards) that cover every request to a local address; they also match some public URLs
 * (a path or query that contains one), which `localRefusal` then reports as public.
 */
export const LOCAL_URL_PATTERNS: readonly string[] = [
  '*://localhost*',
  '*://*.localhost*',
  '*://127.*',
  '*://0.*',
  '*://10.*',
  '*://172.*',
  '*://192.168.*',
  '*://169.254.*',
  '*://[*',
  '*://*@*',
];

/** Whether `hostname` (as `URL` gives it, IPv6 in brackets) is loopback, private or link-local. */
function isLocalHost(hostname: string): boolean {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (/^(127|0|10)\./.test(host) || /^(192\.168|169\.254)\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host))
    return true;
  // IPv6: unspecified, loopback, unique-local, link-local, and IPv4-mapped (which can wrap a local IPv4 address)
  return (
    host.includes(':') &&
    (/^::1?$/.test(host) || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || host.startsWith('::ffff:'))
  );
}

/**
 * Where a request goes: `public`, `local` (loopback, private or link-local: the policy decides), or `refused` (a
 * reserved local port, whatever the policy says). An unparsable URL counts as local, so it gets the checks.
 */
export function localRefusal(url: string): 'public' | 'local' | 'refused' {
  let parts: URL;
  try {
    parts = new URL(url);
  } catch {
    return 'local';
  }
  if (
    parts.protocol !== 'http:' &&
    parts.protocol !== 'https:' &&
    parts.protocol !== 'ws:' &&
    parts.protocol !== 'wss:'
  )
    return 'public'; // not a network address; the scheme check covers documents
  if (!isLocalHost(parts.hostname)) return 'public';
  const port = parts.port || (parts.protocol === 'https:' || parts.protocol === 'wss:' ? '443' : '80');
  return RESERVED_LOCAL_PORTS.has(port) ? 'refused' : 'local';
}

/** One allowlist entry: a host, optionally with a port (`localhost:8000`, `[::1]:3000`). */
interface HostRule {
  host: string;
  port: string | undefined;
}

function parseRule(entry: string): HostRule {
  let parts: URL | undefined;
  try {
    parts = new URL(`https://${entry.trim()}`);
  } catch {
    parts = undefined;
  }
  if (!parts?.hostname || parts.pathname !== '/' || parts.search || parts.hash || parts.username || parts.password)
    throw new Error(`allowHosts: "${entry}" is not a hostname with an optional port`);
  // the port as written: URL drops a scheme's default (443), which would then allow any port
  return { host: parts.hostname.toLowerCase().replace(/\.$/, ''), port: /:(\d+)$/.exec(entry.trim())?.[1] };
}

/**
 * An example policy, not a production one: http(s) pages on the allowed hosts or their subdomains, and the empty
 * tab. An entry with a port (`localhost:8000`) admits only that port; one without admits any. The driver also
 * applies it to redirects and page-started navigations (through request interception), so it must accept full URLs.
 */
export function examplePolicy(allowedHosts: string[]): BetaURLPolicy {
  const rules = allowedHosts.map(parseRule);
  return (_ctx, url) => {
    const text = String(url);
    if (text.toLowerCase() === 'about:blank') return;
    const withScheme = withDefaultScheme(text); // no scheme written: read as https
    let parts: URL;
    try {
      parts = new URL(withScheme.replaceAll('\\', '/')); // a browser reads a backslash in the address as a slash
    } catch {
      throw new ToolError(`blocked: ${text} could not be parsed`);
    }
    const host = parts.hostname.toLowerCase();
    const port = parts.port || (parts.protocol === 'https:' ? '443' : '80');
    const allowed = rules.some(
      (rule) =>
        (host === rule.host || host.endsWith('.' + rule.host)) && (rule.port === undefined || rule.port === port),
    );
    if (!['http:', 'https:'].includes(parts.protocol) || !allowed) {
      throw new ToolError(`blocked: ${text} is not on an allowed host`);
    }
  };
}
