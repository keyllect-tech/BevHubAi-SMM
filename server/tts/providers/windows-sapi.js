// Windows SAPI voices — free, offline, ru-RU and en-US only (no Uzbek culture installed).
//
// One PowerShell run renders every phrase to its own WAV file. A voice of the right language is
// mandatory: an English voice reading Cyrillic produces garbage.

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { VOICE_LANGUAGES } from '../voices.js';

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 60000;
const SAPI = VOICE_LANGUAGES['windows-sapi'].voices;

// PowerShell single-quoted literal: forward slashes, and ' doubled (paths like C:\Users\O'Brien).
const psString = (s) => `'${String(s).replace(/\\/g, '/').replace(/'/g, "''")}'`;

export const provider = {
  id: 'windows-sapi',
  label: VOICE_LANGUAGES['windows-sapi'].label,

  isConfigured: () => process.platform === 'win32' && process.env.TTS_PROVIDER !== 'google',

  async available() {
    return provider.isConfigured();
  },

  /** Renders every phrase; returns the paths, the voice name actually used and its gender. */
  async speakAll({ texts, language, gender, workDir }) {
    const cfg = SAPI[language] || SAPI.ru;
    const male = gender === 'male' && Boolean(cfg.male);
    const preferred = male ? cfg.male : cfg.female;
    const textPath = path.join(workDir, 'voice-text.txt');
    fs.writeFileSync(textPath, texts.join('\n'), 'utf8');
    const outPaths = texts.map((_, i) => path.join(workDir, `voice_${i}.wav`));

    const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voices = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo })
$voice = $voices | Where-Object { $_.Name -eq ${psString(preferred)} } | Select-Object -First 1
if (-not $voice) { $voice = $voices | Where-Object { $_.Culture.Name -eq ${psString(cfg.culture)} -and "$($_.Gender)" -eq ${psString(male ? 'Male' : 'Female')} } | Select-Object -First 1 }
if (-not $voice) { $voice = $voices | Where-Object { $_.Culture.Name -eq ${psString(cfg.culture)} } | Select-Object -First 1 }
if (-not $voice) { throw ${psString(`No ${cfg.culture} voice installed in Windows`)} }
$synth.SelectVoice($voice.Name)
$synth.Rate = 1
$lines = [IO.File]::ReadAllLines(${psString(textPath)}, [Text.Encoding]::UTF8)
$outs = @(${outPaths.map(psString).join(', ')})
# A phrase written in Cyrillic (e.g. a Russian description in an English video) can only be read by a
# Russian voice; an English voice would produce silence.
$ruVoice = $voices | Where-Object { $_.Culture.Name -eq 'ru-RU' } | Select-Object -First 1
for ($i = 0; $i -lt $outs.Length; $i++) {
  if ($ruVoice -and $voice.Culture.Name -ne 'ru-RU' -and $lines[$i] -match '[А-Яа-яЁё]') { $synth.SelectVoice($ruVoice.Name) } else { $synth.SelectVoice($voice.Name) }
  $synth.SetOutputToWaveFile($outs[$i])
  $synth.Speak($lines[$i])
}
$synth.SetOutputToNull()
$synth.Dispose()
Write-Output ("{0}|{1}" -f $voice.Name, $voice.Gender)
`;

    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      timeout: TIMEOUT_MS,
      windowsHide: true,
    });
    for (const p of outPaths) {
      if (!fs.existsSync(p) || fs.statSync(p).size < 1000) throw new Error('offline voice produced no audio');
    }
    const [voice = '', spokenGender = ''] = stdout.trim().split('|');
    return { paths: outPaths, voice, gender: spokenGender.trim().toLowerCase() === 'male' ? 'male' : 'female' };
  },
};