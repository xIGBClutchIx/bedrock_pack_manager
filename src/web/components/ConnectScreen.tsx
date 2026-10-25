/** Saved servers on the left, the connection form on the right. */
import { useEffect, useState, type FormEvent } from "react";

import { ROUTES } from "../../shared/api";
import type { UnknownHostKeyData } from "../../shared/events";
import {
  DEFAULT_PORTS,
  TEST_SERVER,
  describeConnection,
  type ConnectionSettings,
  type KnownHost,
  type LayoutOverrides,
  type Profile,
  type Protocol,
} from "../../shared/model";
import { JobError, deleteProfile, forgetKnownHost, getKnownHosts, saveProfile } from "../api/client";
import { useApp } from "../state/app";
import { Brand, Icon, Modal } from "./common";

const PROTOCOL_CARDS: { id: Protocol; label: string; hint: string }[] = [
  { id: "sftp", label: "SFTP", hint: "SSH, port 22" },
  { id: "ftp", label: "FTP", hint: "Port 21" },
  { id: "ftps", label: "FTPS", hint: "TLS, port 21" },
  { id: "ftps-implicit", label: "Implicit FTPS", hint: "TLS from the start, port 990" },
  { id: "local", label: "This PC", hint: "A server folder on this computer" },
];
const TAGS: Record<Protocol, string> = { sftp: "SFTP", ftp: "FTP", ftps: "FTPS", "ftps-implicit": "FTPS", local: "Local" };

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
  const { state, setState, refresh, run, busy, mark, cancel } = useApp();
  const profiles = state?.profiles ?? [];
  const [form, setForm] = useState<FormState>(EMPTY);
  const [active, setActive] = useState<string | null>(null);
  const [saveAs, setSaveAs] = useState(true);
  const [profileName, setProfileName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [hostKey, setHostKey] = useState<UnknownHostKeyData | null>(null);
  const [keyChanged, setKeyChanged] = useState(false);
  const [hostsOpen, setHostsOpen] = useState(false);
  const [testMode, setTestMode] = useState(false);
  const [testProtocol, setTestProtocol] = useState<"sftp" | "ftp">("sftp");

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
    setTestMode(false);
    setActive(profile.name);
    setForm(fromProfile(profile));
    setProfileName(profile.name);
    setError(null);
    setHostKey(null);
  }

  function settings(trustedFingerprint?: string): ConnectionSettings {
    if (testMode) {
      const sftp = testProtocol === "sftp";
      return {
        protocol: testProtocol,
        host: TEST_SERVER.host,
        port: sftp ? TEST_SERVER.sftpPort : TEST_SERVER.ftpPort,
        username: TEST_SERVER.username,
        password: TEST_SERVER.password,
        root: "",
        tlsVerify: true,
        // The demo server's key is fixed and known, so there is nothing to confirm.
        trustedFingerprint: sftp ? TEST_SERVER.fingerprint : undefined,
      };
    }
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
      trustedFingerprint,
    };
  }

  async function connect(trustedFingerprint?: string) {
    setError(null);
    setKeyChanged(false);
    setHostKey(null);
    const request = settings(trustedFingerprint);
    mark(`Connecting to ${describeConnection(request)}`);
    try {
      await run(ROUTES.connect, { settings: request, layout: testMode ? { packScope: "shared" } : form.layout }, { title: "Connecting" });
      if (saveAs && !testMode) {
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
      if (caught instanceof JobError && caught.job.status === "cancelled") return;
      setError((caught as Error).message);
      setKeyChanged(caught instanceof JobError && caught.code === "host_key_mismatch");
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
        <h2 className="side-label">Saved servers</h2>
        <div className="profile-list">
          {profiles.length === 0 && <p className="empty-note">No saved servers yet. Servers you connect to are saved here.</p>}
          {profiles.map((profile) => (
            <div key={profile.name} className={`profile ${profile.name === active ? "active" : ""}`}>
              <button type="button" className="profile-pick" onClick={() => pick(profile)} title={describeConnection(profile.settings)}>
                <span className={`proto-tag ${profile.settings.protocol}`}>{TAGS[profile.settings.protocol]}</span>
                <span className="names">
                  <b>{profile.name}</b>
                  <span className="addr">{describeConnection(profile.settings).replace(/^[a-z]+:\/\//, "")}</span>
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
            setTestMode(false);
            setProfileName("");
          }}
        >
          <Icon name="plus" />
          New server
        </button>
        <p className="side-foot">
          Passwords are never saved.{" "}
          <button type="button" className="link-btn" onClick={() => setHostsOpen(true)}>
            Manage trusted keys
          </button>
        </p>
      </aside>
      {hostsOpen && <KnownHostsDialog onClose={() => setHostsOpen(false)} />}

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
                  checked={!testMode && form.protocol === card.id}
                  onChange={() => {
                    setTestMode(false);
                    set("protocol", card.id);
                  }}
                />
                <span title={card.hint}>{card.label}</span>
              </label>
            ))}
            {state?.testServer && (
              <label className="proto test">
                <input type="radio" name="protocol" value="test" checked={testMode} onChange={() => setTestMode(true)} />
                <span title="The local demo server from npm run demo">Test server</span>
              </label>
            )}
          </div>

          {testMode && (
            <div className="test-panel">
              <p>
                The local demo server from <code>npm run demo</code>: two worlds and a deliberately messy set of packs. Start it, then
                connect. The address, login and host key are filled in for you.
              </p>
              <div className="setting">
                <div className="grow">
                  <b>Connect over</b>
                  <div className="muted small">
                    {TEST_SERVER.host}:{testProtocol === "sftp" ? TEST_SERVER.sftpPort : TEST_SERVER.ftpPort}, user {TEST_SERVER.username}
                  </div>
                </div>
                <div className="segmented" role="group" aria-label="Test protocol">
                  {(["sftp", "ftp"] as const).map((option) => (
                    <button key={option} type="button" aria-pressed={testProtocol === option} onClick={() => setTestProtocol(option)}>
                      {option.toUpperCase()}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {!testMode && remote && (
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

          {!testMode && (
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
          )}

          <details className="advanced" hidden={testMode}>
            <summary>
              Advanced options <span className="muted small">SSH key, certificates and server folders</span>
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

          {error && (
            <div className="banner danger">
              <div className="grow">
                {error}
                {keyChanged && (
                  <p className="small">
                    If you know the server was reinstalled or moved, check its new fingerprint with your host, then forget the old key.
                  </p>
                )}
              </div>
              {keyChanged && (
                <button type="button" className="btn sm" onClick={() => setHostsOpen(true)}>
                  Trusted keys…
                </button>
              )}
            </div>
          )}

          <div className="row">
            {!testMode && (
              <>
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
              </>
            )}
            <span className="grow" />
            {busy && (
              <button type="button" className="btn ghost lg" onClick={cancel}>
                Cancel
              </button>
            )}
            <button type="submit" className="btn primary lg" disabled={busy}>
              {busy ? "Connecting…" : "Connect"}
            </button>
          </div>
        </form>
      </main>
    </div>
  );
}

/** Trusted SFTP host keys, with a way to forget one (after a server reinstall, say). */
function KnownHostsDialog({ onClose }: { onClose: () => void }) {
  const { confirm, toast } = useApp();
  const [hosts, setHosts] = useState<KnownHost[] | null>(null);
  useEffect(() => {
    getKnownHosts().then(
      (result) => setHosts(result.hosts),
      (error: Error) => toast(error.message, true),
    );
  }, [toast]);

  async function forget(host: KnownHost) {
    const ok = await confirm({
      title: `Forget the key for ${host.host}?`,
      body: (
        <p>
          The next connection will show the server&apos;s current fingerprint for you to check again. Only do this if you know why the key
          changed (a reinstall or a new host) - otherwise someone may be intercepting the connection.
        </p>
      ),
      okLabel: "Forget key",
      danger: true,
    });
    if (!ok) return;
    try {
      setHosts((await forgetKnownHost(host.host, host.port)).hosts);
    } catch (error) {
      toast((error as Error).message, true);
    }
  }

  return (
    <Modal title="Trusted SFTP host keys" onClose={onClose}>
      {hosts === null ? (
        <p className="muted">Reading…</p>
      ) : hosts.length === 0 ? (
        <p className="muted">No trusted keys yet. A key is added when you confirm it on first connect.</p>
      ) : (
        <ul className="hosts-list">
          {hosts.map((host) => (
            <li key={`${host.host}:${host.port}:${host.fingerprint}`}>
              <div className="grow">
                <b>
                  {host.host}:{host.port}
                </b>
                <code className="small">
                  {host.keyType} {host.fingerprint}
                </code>
              </div>
              <button type="button" className="btn sm ghost" onClick={() => void forget(host)}>
                Forget
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="row end">
        <button className="btn" type="button" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}

type LayoutFolder = "serverRoot" | "worldsDir" | "bpDir" | "rpDir";
const LAYOUT_FOLDERS: { key: LayoutFolder; label: string; placeholder: string }[] = [
  { key: "serverRoot", label: "Server folder", placeholder: "auto" },
  { key: "worldsDir", label: "Worlds folder", placeholder: "auto (worlds)" },
  { key: "bpDir", label: "Behavior packs folder", placeholder: "auto (behavior_packs)" },
  { key: "rpDir", label: "Resource packs folder", placeholder: "auto (resource_packs)" },
];

export function LayoutFields({
  layout,
  onChange,
  onBrowse,
}: {
  layout: LayoutOverrides;
  onChange: (key: keyof LayoutOverrides, value: string) => void;
  /** Offer a Browse button per folder (only when connected, so there is something to browse). */
  onBrowse?: (key: LayoutFolder, label: string) => void;
}) {
  return (
    <>
      {LAYOUT_FOLDERS.map(({ key, label, placeholder }) => (
        <label key={key} className="field span2">
          {label}
          <span className="input-with-button">
            <input className="mono" value={layout[key] ?? ""} onChange={(e) => onChange(key, e.target.value)} placeholder={placeholder} />
            {onBrowse && (
              <button type="button" className="btn sm" onClick={() => onBrowse(key, label)} aria-label={`Browse for ${label}`}>
                Browse…
              </button>
            )}
          </span>
        </label>
      ))}
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
