/**
 * Merge CSV/custom columns with email + parsed name fields; replace {token} and {{token}}.
 */
export function replacePlaceholders(
  content: string,
  recipient: { email: string; name: string | null; customFields: string | null }
): string {
  let result = content;

  const customData: Record<string, string> = recipient.customFields ? JSON.parse(recipient.customFields) : {};

  customData['email'] = recipient.email;
  if (recipient.name) {
    customData['name'] = recipient.name;
    customData['firstname'] = recipient.name.split(' ')[0] || '';
    customData['first_name'] = recipient.name.split(' ')[0] || '';
    const nameParts = recipient.name.split(' ');
    customData['lastname'] = nameParts.length > 1 ? nameParts.slice(1).join(' ') : '';
    customData['last_name'] = customData['lastname'];
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
