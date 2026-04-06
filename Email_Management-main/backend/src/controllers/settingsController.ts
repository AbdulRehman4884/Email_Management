import type { Request, Response } from 'express';
import { getSmtpSettingsForApi, saveSmtpSettings } from '../lib/smtpSettings';
import { SMTP_LIMITS, firstLengthViolation } from '../constants/fieldLimits';

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
    if (!provider || !host || port == null || !user || !fromEmail) {
      return res.status(400).json({
        error: 'Missing required fields: provider, host, port, user, fromEmail',
      });
    }
    const portNum = Number(port);
    if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
      return res.status(400).json({ error: 'Invalid port' });
    }
    const providerStr = String(provider);
    const hostStr = String(host);
    const userStr = String(user);
    const fromNameClean = fromName != null ? String(fromName).trim() : '';
    const fromEmailStr = String(fromEmail);
    const trackingStr = trackingBaseUrl != null ? String(trackingBaseUrl).trim() : '';
    const passwordStr = password != null ? String(password) : '';
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
      return res.status(400).json({ error: smtpLenErr });
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
