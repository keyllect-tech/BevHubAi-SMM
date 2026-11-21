$ErrorActionPreference = 'Stop'

function Stop-NodeChildProcess {
  param(
    [Parameter(Mandatory = $true)]
    [object] $Process,
    [int] $TimeoutMilliseconds = 15000
  )

  # $Process is the single System.Diagnostics.Process reference returned by
  # [System.Diagnostics.Process]::Start for this launch. Every message below reports that
  # specific PID; no other process is ever inspected or terminated by this launcher.
  if ($Process.HasExited) {
    if ($Process.WaitForExit($TimeoutMilliseconds)) {
      return $Process.ExitCode
    }
    [Console]::Error.WriteLine("Node PID $($Process.Id) did not exit within $TimeoutMilliseconds ms after reporting HasExited=$true.")
    return 1
  }

  try {
    $Process.StandardInput.WriteLine('__UI_MEDIA_SMOKE_STOP__')
  } catch [System.IO.IOException] {
    [Console]::Error.WriteLine("Could not send graceful stop to Node PID $($Process.Id): $($_.Exception.Message)")
  } catch [System.ObjectDisposedException] {
    [Console]::Error.WriteLine("Could not send graceful stop to Node PID $($Process.Id): stdin is already closed.")
  }
  try {
    $Process.StandardInput.Close()
  } catch [System.IO.IOException] {
    [Console]::Error.WriteLine("Could not close stdin for Node PID $($Process.Id).")
  } catch [System.ObjectDisposedException] {
    [Console]::Error.WriteLine("Could not close stdin for Node PID $($Process.Id): stdin is already closed.")
  }

  if ($Process.WaitForExit($TimeoutMilliseconds)) {
    return $Process.ExitCode
  }

  # Residual risk at timeout: the bounded wait elapsed, so this Node process and any child
  # processes it spawned may still be running, and a child can outlive its parent. The
  # launcher deliberately does not force-kill: no image-wide taskkill, no bulk node.exe
  # termination, and no foreign PIDs, because those could take down unrelated processes, and
  # a forced kill here could leave uncontrolled grandchildren behind. The exact PID and its
  # current state are printed so the operator can inspect and follow up manually.
  [Console]::Error.WriteLine("Node PID $($Process.Id) did not exit within $TimeoutMilliseconds ms (HasExited=$($Process.HasExited)); leaving that process untouched for manual follow-up.")
  return 1
}

if ($MyInvocation.InvocationName -eq '.') {
  return
}

if ($args.Count -ne 0) {
  throw 'This launcher does not accept arguments or storage paths.'
}
if (-not $env:SystemRoot -or -not $env:TEMP -or -not $env:TMP) {
  throw 'SystemRoot, TEMP, and TMP must be present in the parent environment.'
}

$nodeCommand = Get-Command node.exe -CommandType Application -ErrorAction Stop
$nodePath = $nodeCommand.Source
$nodeDirectory = Split-Path -Parent $nodePath
$scriptPath = Join-Path $PSScriptRoot 'ui-media-smoke.mjs'
$system32 = Join-Path $env:SystemRoot 'System32'
$powershellDirectory = Join-Path $system32 'WindowsPowerShell\v1.0'

$startInfo = New-Object System.Diagnostics.ProcessStartInfo
$startInfo.FileName = $nodePath
$startInfo.Arguments = '"' + $scriptPath.Replace('"', '\"') + '"'
$startInfo.WorkingDirectory = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$startInfo.RedirectStandardInput = $true
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
$startInfo.EnvironmentVariables.Clear()
$startInfo.EnvironmentVariables['SystemRoot'] = $env:SystemRoot
$startInfo.EnvironmentVariables['WINDIR'] = $env:SystemRoot
$startInfo.EnvironmentVariables['TEMP'] = $env:TEMP
$startInfo.EnvironmentVariables['TMP'] = $env:TMP
$startInfo.EnvironmentVariables['PATH'] = @($powershellDirectory, $system32, $nodeDirectory) -join ';'
$startInfo.EnvironmentVariables['PATHEXT'] = '.COM;.EXE;.BAT;.CMD'
$startInfo.EnvironmentVariables['MEDIA_SMOKE_LAUNCHER'] = '1'

$process = [System.Diagnostics.Process]::Start($startInfo)
$nodePid = $process.Id
$stdoutEnded = $false
$stderrEnded = $false
$exitCode = $null
$stdoutTask = $process.StandardOutput.ReadLineAsync()
$stderrTask = $process.StandardError.ReadLineAsync()
try {
  while (-not $process.HasExited -or -not $stdoutEnded -or -not $stderrEnded) {
    if (-not $stdoutEnded -and $stdoutTask.IsCompleted) {
      $line = $stdoutTask.Result
      if ($null -eq $line) {
        $stdoutEnded = $true
      } else {
        Write-Output $line
        $stdoutTask = $process.StandardOutput.ReadLineAsync()
      }
    }
    if (-not $stderrEnded -and $stderrTask.IsCompleted) {
      $line = $stderrTask.Result
      if ($null -eq $line) {
        $stderrEnded = $true
      } else {
        Write-Output $line
        $stderrTask = $process.StandardError.ReadLineAsync()
      }
    }
    Start-Sleep -Milliseconds 50
  }
} finally {
  if (-not $process.HasExited) {
    # Bounded graceful stop for this specific PID only. If the helper itself fails, the
    # failure is reported with the PID instead of silently abandoning or force-killing it.
    try {
      $exitCode = Stop-NodeChildProcess -Process $process
    } catch {
      [Console]::Error.WriteLine("Node PID {0} stop helper failed: {1}" -f $nodePid, $_.Exception.Message)
      $exitCode = 1
    }
  }
}
if ($null -eq $exitCode) {
  if ($process.WaitForExit(15000)) {
    $exitCode = $process.ExitCode
  } else {
    [Console]::Error.WriteLine("Node PID {0} did not exit within 15000 ms after stdout/stderr completion (HasExited={1}); leaving that process untouched for manual follow-up." -f $nodePid, $process.HasExited)
    $exitCode = 1
  }
}
exit $exitCode
