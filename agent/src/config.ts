/**
 * Load agent config from /etc/auto-facebook-agent/config.json (written by install.sh).
 */
import { readFileSync } from 'node:fs';

export interface AgentConfig {
  license_key:  string;
  cloud_url:    string;
  installed_at: string | null;
  vnc_password: string | null;
  vnc_port:     number;
}

const DEFAULT_CONFIG_PATH = '/etc/auto-facebook-agent/config.json';

export function loadConfig(path = process.env.AGENT_CONFIG_PATH || DEFAULT_CONFIG_PATH): AgentConfig {
  let raw;
  try { raw = readFileSync(path, 'utf8'); }
  catch (e: any) { throw new Error(`agent: cannot read config at ${path}: ${e.message}`); }
  let cfg: any;
  try { cfg = JSON.parse(raw); }
  catch (e: any) { throw new Error(`agent: config at ${path} is not valid JSON: ${e.message}`); }
  if (!cfg.license_key || typeof cfg.license_key !== 'string') throw new Error('agent: config.license_key missing');
  if (!cfg.cloud_url   || typeof cfg.cloud_url   !== 'string') throw new Error('agent: config.cloud_url missing');
  return {
    license_key:  cfg.license_key,
    cloud_url:    cfg.cloud_url.replace(/\/+$/, ''),
    installed_at: cfg.installed_at ?? null,
    vnc_password: cfg.vnc_password ?? null,
    vnc_port:     Number(cfg.vnc_port ?? 6092),
  };
}
