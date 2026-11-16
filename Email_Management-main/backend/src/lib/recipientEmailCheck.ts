import dns from 'node:dns/promises';

/** False only when DNS clearly says the domain cannot receive mail; DNS trouble counts as fine. */
async function hasMailServer(domain: string): Promise<boolean> {
  try {
    return (await dns.resolveMx(domain)).some((r) => r.exchange && r.exchange !== '.');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOTFOUND') return false;
    if (code !== 'ENODATA') return true;
    return (await dns.resolve4(domain).catch(() => [])).length > 0;
  }
}

/** Common misspellings of the big mail providers, mapped to the right domain. */
const DOMAIN_TYPOS: Record<string, string> = {
  'gmal.com': 'gmail.com', 'gmial.com': 'gmail.com', 'gamil.com': 'gmail.com', 'gmai.com': 'gmail.com',
  'gmaill.com': 'gmail.com', 'gnail.com': 'gmail.com', 'gmail.co': 'gmail.com', 'gmail.con': 'gmail.com',
  'gmail.cm': 'gmail.com', 'gmail.om': 'gmail.com',
  'hotmal.com': 'hotmail.com', 'hotmial.com': 'hotmail.com', 'hotmai.com': 'hotmail.com', 'hotmail.co': 'hotmail.com',
  'hotmail.con': 'hotmail.com',
  'yaho.com': 'yahoo.com', 'yahooo.com': 'yahoo.com', 'yahoo.co': 'yahoo.com', 'yahoo.con': 'yahoo.com',
  'outlok.com': 'outlook.com', 'outllok.com': 'outlook.com', 'outlook.co': 'outlook.com', 'outlook.con': 'outlook.com',
  'iclod.com': 'icloud.com', 'icloud.co': 'icloud.com',
};

export type SuspiciousEmail = { email: string; reason: string };

/**
 * Emails that are well formed but will probably bounce: a misspelled provider domain, or a domain with
 * no mail server. Only reports them; the caller decides what to do. DNS checks stop after `budgetMs`.
 */
export async function findSuspiciousEmails(
  emails: string[],
  checkDomain: (domain: string) => Promise<boolean> = hasMailServer,
  budgetMs = 5000,
): Promise<SuspiciousEmail[]> {
  const byDomain = new Map<string, string[]>();
  for (const email of emails) {
    const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase().trim();
    if (!domain) continue;
    byDomain.set(domain, [...(byDomain.get(domain) ?? []), email]);
  }

  const result: SuspiciousEmail[] = [];
  const toCheck: string[] = [];
  for (const [domain, list] of byDomain) {
    const fix = DOMAIN_TYPOS[domain];
    if (fix) list.forEach((email) => result.push({ email, reason: `did you mean ${fix}?` }));
    else toCheck.push(domain);
  }

  const deadline = Date.now() + budgetMs;
  const noMailServer = new Set<string>();
  for (let i = 0; i < toCheck.length && Date.now() < deadline; i += 20) {
    const batch = toCheck.slice(i, i + 20);
    const checks = batch.map((d) => checkDomain(d).then((ok) => { if (!ok) noMailServer.add(d); }, () => undefined));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise((r) => { timer = setTimeout(r, Math.max(0, deadline - Date.now())); });
    await Promise.race([Promise.all(checks), timeout]);
    clearTimeout(timer);
  }
  for (const domain of noMailServer) {
    byDomain.get(domain)!.forEach((email) => result.push({ email, reason: 'domain has no mail server' }));
  }
  return result;
}
