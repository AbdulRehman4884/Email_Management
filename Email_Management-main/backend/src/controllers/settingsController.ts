import type { Request, Response } from 'express';
import { getSmtpSettingsForApi, saveSmtpSettings } from '../lib/smtpSettings';
import { SMTP_LIMITS, firstLengthViolation } from '../constants/fieldLimits';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function getSmtpSettingsHandler(req: Request, res: Response) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const settings = await getSmtpSettingsForApi(userId);
    if (!settings) {
      return res.status(200).json({
        provider: '',
        host: '',
        port: 587,
        secure: false,
        user: '',
        fromName: '',
        fromEmail: '',
        trackingBaseUrl: '',
        hasPassword: false,
      });
    }
    res.status(200).json({
      id: settings.id,
      provider: settings.provider,
      host: settings.host,
      port: settings.port,
      secure: settings.secure,
      user: settings.user,
      password: settings.password ?? '',
      fromName: settings.fromName ?? '',
      fromEmail: settings.fromEmail,
      trackingBaseUrl: settings.trackingBaseUrl ?? '',
      updatedAt: settings.updatedAt,
      hasPassword: Boolean(settings.password),
    });
  } catch (error) {
    console.error('Error fetching SMTP settings:', error);
    res.status(500).json({ error: 'Failed to retrieve SMTP settings' });
  }
}

export async function putSmtpSettingsHandler(req: Request, res: Response) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const { provider, host, port, secure, user, password, fromName, fromEmail, trackingBaseUrl } = req.body;
    const providerStr = String(provider ?? '').trim();
    const hostStr = String(host ?? '').trim();
    const userStr = String(user ?? '').trim();
    const fromNameClean = fromName != null ? String(fromName).trim() : '';
    const fromEmailStr = String(fromEmail ?? '').trim();
    const trackingStr = trackingBaseUrl != null ? String(trackingBaseUrl).trim() : '';
    const passwordStr = password != null ? String(password) : '';
    const portRaw = String(port ?? '').trim();

    const fieldErrors: Record<string, string> = {};

    if (!providerStr) fieldErrors.provider = 'Provider is required.';
    if (!hostStr) fieldErrors.host = 'SMTP host is required.';
    if (!portRaw) {
      fieldErrors.port = 'Port is required.';
    }

    const portNum = Number(portRaw);
    if (!fieldErrors.port && (Number.isNaN(portNum) || portNum < 1 || portNum > 65535)) {
      fieldErrors.port = 'Port must be between 1 and 65535.';
    }

    if (!userStr) {
      fieldErrors.user = 'Username is required.';
    } else if (!EMAIL_REGEX.test(userStr)) {
      fieldErrors.user = 'Username must be a valid email address.';
    }
    if (!fromEmailStr) {
      fieldErrors.fromEmail = 'From email is required.';
    } else if (!EMAIL_REGEX.test(fromEmailStr)) {
      fieldErrors.fromEmail = 'From email must be a valid email address.';
    }
    if (userStr && fromEmailStr && EMAIL_REGEX.test(userStr) && EMAIL_REGEX.test(fromEmailStr) && userStr.toLowerCase() !== fromEmailStr.toLowerCase()) {
      fieldErrors.user = 'Username and From email must be the same.';
      fieldErrors.fromEmail = 'From email and Username must be the same.';
    }

    if (Object.keys(fieldErrors).length > 0) {
      return res.status(400).json({
        error: 'Please fix the highlighted fields.',
        fieldErrors,
      });
    }

    const smtpChecks: Array<{ label: string; value: string; max: number }> = [
      { label: 'Provider', value: providerStr, max: SMTP_LIMITS.provider },
      { label: 'SMTP host', value: hostStr, max: SMTP_LIMITS.host },
      { label: 'Username', value: userStr, max: SMTP_LIMITS.user },
      { label: 'Sender name', value: fromNameClean, max: SMTP_LIMITS.fromName },
      { label: 'From email', value: fromEmailStr, max: SMTP_LIMITS.fromEmail },
    ];
    if (trackingStr) {
      smtpChecks.push({ label: 'Tracking base URL', value: trackingStr, max: SMTP_LIMITS.trackingBaseUrl });
    }
    if (passwordStr) {
      smtpChecks.push({ label: 'Password', value: passwordStr, max: SMTP_LIMITS.password });
    }
    const smtpLenErr = firstLengthViolation(smtpChecks);
    if (smtpLenErr) {
      const lengthFieldErrors: Record<string, string> = {};
      if (smtpLenErr.startsWith('Provider ')) lengthFieldErrors.provider = smtpLenErr;
      if (smtpLenErr.startsWith('SMTP host ')) lengthFieldErrors.host = smtpLenErr;
      if (smtpLenErr.startsWith('Username ')) lengthFieldErrors.user = smtpLenErr;
      if (smtpLenErr.startsWith('From email ')) lengthFieldErrors.fromEmail = smtpLenErr;
      return res.status(400).json({
        error: smtpLenErr,
        ...(Object.keys(lengthFieldErrors).length > 0 ? { fieldErrors: lengthFieldErrors } : {}),
      });
    }
    await saveSmtpSettings(userId, {
      provider: providerStr,
      host: hostStr,
      port: portNum,
      secure: Boolean(secure),
      user: userStr,
      password: passwordStr,
      fromName: fromNameClean,
      fromEmail: fromEmailStr,
      trackingBaseUrl: trackingStr || null,
    });
    res.status(200).json({ message: 'SMTP settings saved successfully' });
  } catch (error) {
    console.error('Error saving SMTP settings:', error);
    res.status(500).json({ error: 'Failed to save SMTP settings' });
  }
}
