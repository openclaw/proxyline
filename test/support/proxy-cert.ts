import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type ProxyTestCertificate = {
  certificate: string;
  privateKey: string;
  cleanup: () => Promise<void>;
};

export type ProxyTestCertificateOptions = {
  dnsNames?: string[];
  ipAddresses?: string[];
};

function buildSubjectAltNames(options: ProxyTestCertificateOptions): string {
  const dnsNames = options.dnsNames ?? ["localhost"];
  const ipAddresses = options.ipAddresses ?? ["127.0.0.1"];
  const entries: string[] = [];
  for (const [index, ipAddress] of ipAddresses.entries()) {
    entries.push(`IP.${index + 1} = ${ipAddress}`);
  }
  for (const [index, dnsName] of dnsNames.entries()) {
    entries.push(`DNS.${index + 1} = ${dnsName}`);
  }
  return entries.join("\n");
}

function buildOpenSslConfig(options: ProxyTestCertificateOptions): string {
  return `[req]
distinguished_name = dn
x509_extensions = v3_req
prompt = no
[dn]
CN = Proxyline Test Proxy
[v3_req]
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names
[alt_names]
${buildSubjectAltNames(options)}
`;
}

export async function createProxyTestCertificate(
  options: ProxyTestCertificateOptions = {},
): Promise<ProxyTestCertificate> {
  const directory = await mkdtemp(join(tmpdir(), "proxyline-cert-"));
  const configPath = join(directory, "openssl.cnf");
  const keyPath = join(directory, "proxy-key.pem");
  const certificatePath = join(directory, "proxy-cert.pem");

  try {
    await writeFile(configPath, buildOpenSslConfig(options), "utf8");
    await execFileAsync("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-keyout",
      keyPath,
      "-out",
      certificatePath,
      "-config",
      configPath,
    ]);
    const [certificate, privateKey] = await Promise.all([
      readFile(certificatePath, "utf8"),
      readFile(keyPath, "utf8"),
    ]);
    return {
      certificate,
      privateKey,
      cleanup: async () => {
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to generate proxy test certificate with openssl: ${message}`);
  }
}
