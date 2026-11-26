param([string]$Tsv, [string]$Out)
# The English clips of the T58 set, from Windows' own speech synthesizer (no download), 16 kHz mono 16-bit.
[System.Diagnostics.Process]::GetCurrentProcess().PriorityClass = 'BelowNormal'
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
foreach ($line in [System.IO.File]::ReadAllLines($Tsv, [System.Text.Encoding]::UTF8)) {
    $f = $line -split "`t", 3
    if ($f[1] -ne 'en') { continue }
    $synth.SetOutputToWaveFile((Join-Path $Out ($f[0] + '.wav')), $format)
    $synth.Speak($f[2])
    $synth.SetOutputToNull()
}
$synth.Dispose()
