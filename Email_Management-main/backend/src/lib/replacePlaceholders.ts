/**
 * Merge CSV/custom columns with email + parsed name fields; replace {token} and {{token}}.
 */
export function replacePlaceholders(
  content: string,
  recipient: { email: string; name: string | null; customFields: string | null }
): string {
  let result = content;

  let raw: Record<string, string> = {};
  try {
    raw = recipient.customFields ? JSON.parse(recipient.customFields) : {};
  } catch {
    raw = {};
  }
  const customData: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    customData[k.toLowerCase()] = v;
  }

  if (!customData.company) {
    if (customData.company_name) customData.company = customData.company_name;
    else if (customData.organization) customData.company = customData.organization;
    else if (customData.org) customData.company = customData.org;
  }

  customData['email'] = recipient.email;
  const nameStr = (recipient.name || '').trim();
  if (nameStr) {
    customData['name'] = nameStr;
    customData['firstname'] = nameStr.split(' ')[0] || '';
    customData['first_name'] = nameStr.split(' ')[0] || '';
    const nameParts = nameStr.split(' ');
    customData['lastname'] = nameParts.length > 1 ? nameParts.slice(1).join(' ') : '';
    customData['last_name'] = customData['lastname'];
  } else if (!customData['name']) {
    const first = (customData['firstname'] || customData['first_name'] || '').trim();
    const last = (customData['lastname'] || customData['last_name'] || '').trim();
    if (first || last) {
      customData['name'] = [first, last].filter(Boolean).join(' ');
      if (!customData['firstname'] && first) customData['firstname'] = first;
      if (!customData['first_name'] && first) customData['first_name'] = first;
      if (!customData['lastname'] && last) customData['lastname'] = last;
      if (!customData['last_name'] && last) customData['last_name'] = last;
    }
  }

  result = result.replace(/\{\{([a-z_][a-z0-9_]*)\}\}/gi, (_match, key: string) => {
    const normalizedKey = key.toLowerCase();
    return customData[normalizedKey] ?? '';
  });

  result = result.replace(/\{([a-z_][a-z0-9_]*)\}/gi, (_match, key: string) => {
    const normalizedKey = key.toLowerCase();
    return customData[normalizedKey] ?? '';
  });

  return result;
}
