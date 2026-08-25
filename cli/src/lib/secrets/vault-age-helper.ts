import { Decrypter, Encrypter, armor } from 'age-encryption';

interface AgeInput {
  action: 'encrypt' | 'decrypt';
  passphrase: string;
  plaintext?: string;
  blob?: string;
  scryptWorkFactor?: number;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function runAge(input: AgeInput): Promise<string> {
  if (input.action === 'encrypt') {
    const encrypter = new Encrypter();
    if (input.scryptWorkFactor !== undefined) {
      encrypter.setScryptWorkFactor(input.scryptWorkFactor);
    }
    encrypter.setPassphrase(input.passphrase);
    return armor.encode(await encrypter.encrypt(input.plaintext ?? ''));
  }
  if (input.action === 'decrypt') {
    const decrypter = new Decrypter();
    decrypter.addPassphrase(input.passphrase);
    return await decrypter.decrypt(armor.decode(input.blob ?? ''), 'text');
  }
  throw new Error('unknown action');
}

export async function runVaultAgeHelperCli(): Promise<void> {
  try {
    const input = JSON.parse(await readStdin()) as AgeInput;
    process.stdout.write(await runAge(input));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
