import type { Request, Response } from 'express';
import { getSmtpSettingsForApi, saveSmtpSettings } from '../lib/smtpSettings';

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
      fromName: settings.fromName ?? '',
      fromEmail: settings.fromEmail,
      trackingBaseUrl: settings.trackingBaseUrl ?? '',
      updatedAt: settings.updatedAt,
      hasPassword: true,
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
    await saveSmtpSettings(userId, {
      provider: String(provider),
      host: String(host),
      port: portNum,
      secure: Boolean(secure),
      user: String(user),
      password: password != null ? String(password) : '',
      fromName: fromName != null ? String(fromName).trim() : '',
      fromEmail: String(fromEmail),
      trackingBaseUrl: trackingBaseUrl != null ? String(trackingBaseUrl).trim() || null : null,
    });
    res.status(200).json({ message: 'SMTP settings saved successfully' });
  } catch (error) {
    console.error('Error saving SMTP settings:', error);
    res.status(500).json({ error: 'Failed to save SMTP settings' });
  }
}
