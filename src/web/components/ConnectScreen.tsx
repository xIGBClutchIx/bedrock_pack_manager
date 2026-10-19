/** Saved servers on the left, the connection form on the right. */
import { useEffect, useState, type FormEvent } from "react";

import { ROUTES } from "../../shared/api";
import type { UnknownHostKeyData } from "../../shared/events";
import {
  DEFAULT_PORTS,
  describeConnection,
  type ConnectionSettings,
  type LayoutOverrides,
  type Profile,
  type Protocol,
} from "../../shared/model";
import { JobError, deleteProfile, saveProfile } from "../api/client";
import { useApp } from "../state/app";
import { Brand, Icon } from "./common";

const PROTOCOL_CARDS: { id: Protocol; label: string; hint: string }[] = [
  { id: "sftp", label: "SFTP", hint: "SSH, port 22" },
  { id: "ftp", label: "FTP", hint: "Port 21" },
  { id: "ftps", label: "FTPS", hint: "TLS, port 21" },
  { id: "ftps-implicit", label: "FTPS implicit", hint: "TLS, port 990" },
  { id: "local", label: "This PC", hint: "A local folder" },
];
const TAGS: Record<Protocol, string> = { sftp: "SFTP", ftp: "FTP", ftps: "FTPS", "ftps-implicit": "FTPS", local: "LOCAL" };

interface FormState {
  protocol: Protocol;
  host: string;
  port: string;
  username: string;
  password: string;
  root: string;
  keyFile: string;
  keyPassphrase: string;
  allowSelfSigned: boolean;
  layout: LayoutOverrides;
}

const EMPTY: FormState = {
  protocol: "sftp",
  host: "",
  port: "",
  username: "",
  password: "",
  root: "",
  keyFile: "",
  keyPassphrase: "",
  allowSelfSigned: false,
  layout: { packScope: "shared" },
};

function fromProfile(profile: Profile): FormState {
  const s = profile.settings;
  return {
    ...EMPTY,
    protocol: s.protocol,
    host: s.host,
    port: s.port ? String(s.port) : "",
    username: s.username,
    root: s.root,
    keyFile: s.keyFile ?? "",
    allowSelfSigned: s.tlsVerify === false,
    layout: { ...profile.layout, packScope: profile.layout.packScope ?? "shared" },
  };
}

export function ConnectScreen() {
  const { state, setState, refresh, run, busy, mark } = useApp();
  const profiles = state?.profiles ?? [];
  const [form, setForm] = useState<FormState>(EMPTY);
  const [active, setActive] = useState<string | null>(null);
  const [saveAs, setSaveAs] = useState(true);
  const [profileName, setProfileName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [hostKey, setHostKey] = useState<UnknownHostKeyData | null>(null);

  // Start from the first saved server, so a returning user only types the password.
  useEffect(() => {
    if (!active && profiles.length && !form.host) pick(profiles[0]!);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profiles.length]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((current) => ({ ...current, [key]: value }));
  const setLayout = (key: keyof LayoutOverrides, value: string) =>
    setForm((current) => ({ ...current, layout: { ...current.layout, [key]: value || undefined } }));
  const remote = form.protocol !== "local";

  function pick(profile: Profile) {
    setActive(profile.name);
    setForm(fromProfile(profile));
    setProfileName(profile.name);
    setError(null);
    setHostKey(null);
  }

  function settings(trustedFingerprint?: string): ConnectionSettings {
    return {
      protocol: form.protocol,
      host: form.host.trim(),
      port: form.port ? Number(form.port) : null,
      username: form.username.trim(),
      password: form.password,
      root: form.root.trim(),
      keyFile: form.keyFile.trim() || undefined,
      keyPassphrase: form.keyPassphrase || undefined,
      tlsVerify: !form.allowSelfSigned,
      passive: true,
      trustedFingerprint,
    };
  }

  async function connect(trustedFingerprint?: string) {
    setError(null);
    setHostKey(null);
    const request = settings(trustedFingerprint);
    mark(`Connecting to ${describeConnection(request)}`);
    try {
      await run(ROUTES.connect, { settings: request, layout: form.layout }, { title: "Connecting" });
      if (saveAs) {
        const name = profileName.trim() || (remote ? form.host.trim() : "Local server");
        const { password: _password, keyPassphrase: _passphrase, trustedFingerprint: _fingerprint, ...publicPart } = request;
        if (name) await saveProfile({ name, settings: publicPart, layout: form.layout }).catch(() => undefined);
      }
      setState(await refresh());
    } catch (caught) {
      if (caught instanceof JobError && caught.code === "unknown_host_key") {
        setHostKey(caught.job.errorData as unknown as UnknownHostKeyData);
        return;
      }
      setError((caught as Error).message);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void connect();
  }

  async function remove(name: string) {
    await deleteProfile(name);
    if (active === name) setActive(null);
    await refresh();
  }

  return (
    <div className="connect-screen">
      <aside className="connect-side">
        <Brand />
        <h2 className="eyebrow">Saved servers</h2>
        <div className="profile-list">
          {profiles.length === 0 && <p className="empty-note">No saved servers yet. Connect once with “Save as a server” ticked.</p>}
          {profiles.map((profile) => (
            <div key={profile.name} className={`profile ${profile.name === active ? "active" : ""}`}>
              <button type="button" className="profile-pick" onClick={() => pick(profile)}>
                <span className={`proto-tag ${profile.settings.protocol}`}>{TAGS[profile.settings.protocol]}</span>
                <span className="names">
                  <b>{profile.name}</b>
                  <span className="addr">{describeConnection(profile.settings)}</span>
                </span>
              </button>
              <button type="button" className="del" aria-label={`Delete ${profile.name}`} onClick={() => void remove(profile.name)}>
                <Icon name="close" />
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          className="btn dashed"
          onClick={() => {
            setActive(null);
            setForm(EMPTY);
            setProfileName("");
          }}
        >
          + New server
        </button>
        <p className="side-foot">
          Passwords are never saved. Trusted SFTP host keys are kept in <code>run/known_hosts</code>.
        </p>
      </aside>

      <main className="connect-main">
        <form className="connect-form" onSubmit={submit} autoComplete="off">
          <div>
            <h1>Connect to a server</h1>
            <p className="muted">The server folder, worlds and pack folders are found automatically.</p>
          </div>

          <div className="proto-grid" role="radiogroup" aria-label="Protocol">
            {PROTOCOL_CARDS.map((card) => (
              <label key={card.id} className="proto">
                <input
                  type="radio"
                  name="protocol"
                  value={card.id}
                  checked={form.protocol === card.id}
                  onChange={() => set("protocol", card.id)}
                />
                <span>
                  <b>{card.label}</b>
                  <small>{card.hint}</small>
                </span>
              </label>
            ))}
          </div>

          {remote && (
            <div className="grid4">
              <label className="field span3">
                Host
                <input
                  value={form.host}
                  onChange={(e) => set("host", e.target.value)}
                  placeholder="play.example.com or 192.168.1.20"
                  required
                />
              </label>
              <label className="field">
                Port
                <input
                  value={form.port}
                  onChange={(e) => set("port", e.target.value.replace(/\D/g, ""))}
                  inputMode="numeric"
                  placeholder={String(DEFAULT_PORTS[form.protocol] ?? "")}
                />
              </label>
              <label className="field span2">
                Username
                <input value={form.username} onChange={(e) => set("username", e.target.value)} autoComplete="username" />
              </label>
              <label className="field span2">
                Password
                <input
                  type="password"
                  value={form.password}
                  onChange={(e) => set("password", e.target.value)}
                  autoComplete="current-password"
                  placeholder="Kept in memory only"
                />
              </label>
            </div>
          )}

          <label className="field">
            {remote ? "Folder on the server" : "Server folder on this computer"}
            <input
              className="mono"
              value={form.root}
              onChange={(e) => set("root", e.target.value)}
              placeholder={
                remote ? "Empty = login folder, e.g. /home/container" : "Empty = the bundled run/ folder, or e.g. C:\\servers\\bedrock"
              }
            />
          </label>

          <details className="advanced">
            <summary>
              Advanced <span className="muted">— SSH key, certificates, layout overrides</span>
            </summary>
            <div className="grid4">
              {form.protocol === "sftp" && (
                <>
                  <label className="field span2">
                    SSH key file
                    <input
                      className="mono"
                      value={form.keyFile}
                      onChange={(e) => set("keyFile", e.target.value)}
                      placeholder="C:\Users\me\.ssh\id_ed25519"
                    />
                  </label>
                  <label className="field span2">
                    Key passphrase
                    <input type="password" value={form.keyPassphrase} onChange={(e) => set("keyPassphrase", e.target.value)} />
                  </label>
                </>
              )}
              {(form.protocol === "ftps" || form.protocol === "ftps-implicit") && (
                <label className="check span4">
                  <input type="checkbox" checked={form.allowSelfSigned} onChange={(e) => set("allowSelfSigned", e.target.checked)} /> Allow
                  self-signed certificate
                </label>
              )}
              <LayoutFields layout={form.layout} onChange={setLayout} />
            </div>
          </details>

          {hostKey && (
            <div className="hostkey" role="alert">
              <b>
                First time connecting to {hostKey.host}:{hostKey.port}
              </b>
              <span>Check this matches the SSH fingerprint your host shows before trusting it.</span>
              <code>
                {hostKey.keyType} {hostKey.fingerprint}
              </code>
              <div className="row end">
                <button type="button" className="btn warn-ghost" onClick={() => setHostKey(null)}>
                  Cancel
                </button>
                <button type="button" className="btn warn" onClick={() => void connect(hostKey.fingerprint)} autoFocus>
                  Trust and connect
                </button>
              </div>
            </div>
          )}

          {error && <div className="banner danger">{error}</div>}

          <div className="row">
            <label className="check">
              <input type="checkbox" checked={saveAs} onChange={(e) => setSaveAs(e.target.checked)} /> Save as a server (no password)
            </label>
            <input
              className="profile-name"
              value={profileName}
              onChange={(e) => setProfileName(e.target.value)}
              placeholder="Name, e.g. SMP (main)"
              aria-label="Server name"
            />
            <span className="grow" />
            <button type="submit" className="btn primary lg" disabled={busy}>
              {busy ? "Connecting…" : "Connect"}
            </button>
          </div>
        </form>
      </main>
    </div>
  );
}

export function LayoutFields({
  layout,
  onChange,
}: {
  layout: LayoutOverrides;
  onChange: (key: keyof LayoutOverrides, value: string) => void;
}) {
  return (
    <>
      <label className="field span2">
        Server folder
        <input
          className="mono"
          value={layout.serverRoot ?? ""}
          onChange={(e) => onChange("serverRoot", e.target.value)}
          placeholder="auto"
        />
      </label>
      <label className="field span2">
        Worlds folder
        <input
          className="mono"
          value={layout.worldsDir ?? ""}
          onChange={(e) => onChange("worldsDir", e.target.value)}
          placeholder="auto (worlds)"
        />
      </label>
      <label className="field span2">
        Behavior packs folder
        <input
          className="mono"
          value={layout.bpDir ?? ""}
          onChange={(e) => onChange("bpDir", e.target.value)}
          placeholder="auto (behavior_packs)"
        />
      </label>
      <label className="field span2">
        Resource packs folder
        <input
          className="mono"
          value={layout.rpDir ?? ""}
          onChange={(e) => onChange("rpDir", e.target.value)}
          placeholder="auto (resource_packs)"
        />
      </label>
      <label className="field span4">
        New packs go to
        <select value={layout.packScope} onChange={(e) => onChange("packScope", e.target.value)}>
          <option value="shared">Shared server folders (behavior_packs / resource_packs)</option>
          <option value="world">The world&apos;s own folders (worlds/&lt;world&gt;/behavior_packs)</option>
        </select>
      </label>
    </>
  );
}
