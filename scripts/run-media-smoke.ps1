$ErrorActionPreference = 'Stop'

if ($args.Count -ne 0) {
  throw 'This launcher does not accept arguments or storage paths.'
}
if (-not $env:SystemRoot -or -not $env:TEMP -or -not $env:TMP) {
  throw 'SystemRoot, TEMP, and TMP must be present in the parent environment.'
}

$startUtc = [DateTimeOffset]::UtcNow
$timeoutMs = 360000
$shutdownGraceMs = 10000
$verifyGraceMs = 5000
$deadlineAtMs = $startUtc.ToUnixTimeMilliseconds() + $timeoutMs
$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
$gracefulStopAfterMs = $timeoutMs - $shutdownGraceMs - $verifyGraceMs
$forceStopAfterMs = $timeoutMs - $verifyGraceMs
$verificationStopAfterMs = $timeoutMs

$nativeSource = @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;

public sealed class MediaSmokeProcessRecord
{
    public uint ProcessId { get; set; }
    public int? ExitCode { get; set; }
    public string State { get; set; }
    public string Diagnostic { get; set; }
}

public sealed class MediaSmokeProcessJob : IDisposable
{
    private const uint CreateSuspended = 0x00000004;
    private const uint CreateNewProcessGroup = 0x00000200;
    private const uint CreateUnicodeEnvironment = 0x00000400;
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;
    private const int JobObjectAssociateCompletionPortInformation = 7;
    private const int JobObjectExtendedLimitInformation = 9;
    private const int JobObjectBasicAccountingInformation = 1;
    private const int JobObjectBasicProcessIdList = 3;
    private const uint JobMessageNewProcess = 6;
    private const uint JobMessageExitProcess = 7;
    private const uint JobMessageAbnormalExitProcess = 8;
    private const uint ProcessQueryLimitedInformation = 0x1000;
    private const uint Synchronize = 0x00100000;
    private const uint WaitObject0 = 0;
    private const uint WaitTimeout = 258;
    private const uint WaitFailed = UInt32.MaxValue;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        public int Size;
        public string Reserved;
        public string Desktop;
        public string Title;
        public int X;
        public int Y;
        public int XSize;
        public int YSize;
        public int XCountChars;
        public int YCountChars;
        public int FillAttribute;
        public int Flags;
        public short ShowWindow;
        public short Reserved2Size;
        public IntPtr Reserved2;
        public IntPtr StdInput;
        public IntPtr StdOutput;
        public IntPtr StdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        public IntPtr Process;
        public IntPtr Thread;
        public uint ProcessId;
        public uint ThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimitInformation
    {
        public BasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct CompletionPortAssociation
    {
        public IntPtr CompletionKey;
        public IntPtr CompletionPort;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicAccountingInformation
    {
        public long TotalUserTime;
        public long TotalKernelTime;
        public long ThisPeriodTotalUserTime;
        public long ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount;
        public uint TotalProcesses;
        public uint ActiveProcesses;
        public uint TotalTerminatedProcesses;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int informationClass, IntPtr information, uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(IntPtr job, int informationClass, IntPtr information, uint informationLength, out uint returnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateIoCompletionPort(IntPtr file, IntPtr existingPort, UIntPtr completionKey, uint concurrentThreads);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetQueuedCompletionStatus(IntPtr port, out uint bytes, out UIntPtr completionKey, out IntPtr overlapped, uint milliseconds);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(string applicationName, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint creationFlags, IntPtr environment, string currentDirectory, ref StartupInfo startupInfo, out ProcessInformation processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GenerateConsoleCtrlEvent(uint controlEvent, uint processGroupId);

    private IntPtr _job;
    private IntPtr _completionPort;
    private readonly Dictionary<uint, IntPtr> _processHandles = new Dictionary<uint, IntPtr>();
    private readonly List<MediaSmokeProcessRecord> _records = new List<MediaSmokeProcessRecord>();
    private readonly List<string> _diagnostics = new List<string>();
    private readonly HashSet<uint> _lastKnownActivePids = new HashSet<uint>();
    private MediaSmokeProcessRecord _rootRecord;
    private IntPtr _rootProcessHandle;
    private string _rootProcessHandleState = "not_created";
    private IntPtr _rootThreadHandle;
    private bool _rootCreationAttempted;
    private bool _rootAssignedToJob;
    private bool _rootTerminationConfirmed;
    private bool _finalAccountingKnown;
    private uint _finalTotalProcesses;
    private uint _finalActiveProcesses;
    private uint _finalTerminatedProcesses;

    public uint RootProcessId { get; private set; }
    public int? RootExitCode { get; private set; }
    public bool RootExited { get; private set; }
    public bool RootCreationAttempted { get { return _rootCreationAttempted; } }
    public bool RootAssignedToJob { get { return _rootAssignedToJob; } }
    public bool RootTerminationConfirmed { get { return _rootTerminationConfirmed; } }
    public string RootDiagnostic { get; private set; }
    public bool RootCreationFailed { get; private set; }
    public bool IsDisposed { get; private set; }
    public string[] Diagnostics { get { return _diagnostics.ToArray(); } }

    public bool TerminationVerified
    {
        get
        {
            RefreshRootStatus();
            BasicAccountingInformation accounting;
            if (!TryGetJobAccounting(out accounting)) return false;
            if (accounting.ActiveProcesses != 0 ||
                accounting.TotalProcesses != accounting.TotalTerminatedProcesses) return false;
            if (_lastKnownActivePids.Count != 0) return false;
            int expectedJobRecords = _records.Count - (RootProcessId != 0 && !_rootAssignedToJob ? 1 : 0);
            if (accounting.TotalProcesses != (uint)Math.Max(0, expectedJobRecords)) return false;
            if (!_rootCreationAttempted) return _records.Count == 0;
            if (RootProcessId == 0) return _records.Count == 0;
            if (_rootRecord == null || !_records.Contains(_rootRecord)) return false;
            if (!RootExited || !RootExitCode.HasValue) return false;
            if (!_rootAssignedToJob && !_rootTerminationConfirmed) return false;
            if (GetJobActiveProcessIds().Length != 0) return false;
            return _records.All(record =>
                (record.State == "exited" || record.State == "abnormally_exited") &&
                record.ExitCode.HasValue) &&
                _processHandles.Count == 0 &&
                _rootProcessHandle == IntPtr.Zero &&
                (_rootProcessHandleState == "not_created" || _rootProcessHandleState == "released");
        }
    }

    public bool HasUnreconciledProcessRecords
    {
        get
        {
            BasicAccountingInformation accounting;
            if (!TryGetJobAccounting(out accounting)) return false;
            int expectedJobRecords = _records.Count - (RootProcessId != 0 && !_rootAssignedToJob ? 1 : 0);
            return accounting.TotalProcesses > (uint)Math.Max(0, expectedJobRecords) ||
                _records.Any(record =>
                    record.State == "running" ||
                    record.State == "created_suspended" ||
                    record.State == "assigned_suspended");
        }
    }

    public MediaSmokeProcessJob()
    {
        _job = CreateJobObject(IntPtr.Zero, null);
        if (_job == IntPtr.Zero) throw NativeError("CreateJobObject");
        try
        {
            ExtendedLimitInformation limits = new ExtendedLimitInformation();
            limits.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
            IntPtr limitsPointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(ExtendedLimitInformation)));
            try
            {
                Marshal.StructureToPtr(limits, limitsPointer, false);
                if (!SetInformationJobObject(_job, JobObjectExtendedLimitInformation, limitsPointer, (uint)Marshal.SizeOf(typeof(ExtendedLimitInformation))))
                    throw NativeError("SetInformationJobObject(KILL_ON_JOB_CLOSE)");
            }
            finally
            {
                Marshal.FreeHGlobal(limitsPointer);
            }

            _completionPort = CreateIoCompletionPort(new IntPtr(-1), IntPtr.Zero, UIntPtr.Zero, 1);
            if (_completionPort == IntPtr.Zero) throw NativeError("CreateIoCompletionPort");
            CompletionPortAssociation association = new CompletionPortAssociation();
            association.CompletionKey = new IntPtr(1);
            association.CompletionPort = _completionPort;
            IntPtr associationPointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(CompletionPortAssociation)));
            try
            {
                Marshal.StructureToPtr(association, associationPointer, false);
                if (!SetInformationJobObject(_job, JobObjectAssociateCompletionPortInformation, associationPointer, (uint)Marshal.SizeOf(typeof(CompletionPortAssociation))))
                    throw NativeError("SetInformationJobObject(completion port)");
            }
            finally
            {
                Marshal.FreeHGlobal(associationPointer);
            }
        }
        catch (Exception constructionError)
        {
            List<string> cleanupErrors = new List<string>();
            if (_completionPort != IntPtr.Zero)
            {
                if (CloseHandle(_completionPort))
                    _completionPort = IntPtr.Zero;
                else
                    cleanupErrors.Add("completion-port CloseHandle failed with Win32 error " + Marshal.GetLastWin32Error());
            }
            if (_job != IntPtr.Zero)
            {
                if (CloseHandle(_job))
                    _job = IntPtr.Zero;
                else
                    cleanupErrors.Add("job CloseHandle failed with Win32 error " + Marshal.GetLastWin32Error());
            }
            if (cleanupErrors.Count > 0)
                throw new InvalidOperationException(constructionError.Message + "; cleanup: " + String.Join("; ", cleanupErrors), constructionError);
            throw;
        }
    }

    public void Start(string application, string script, string workingDirectory, string[] environmentEntries, uint failureGraceMilliseconds)
    {
        if (RootProcessId != 0) throw new InvalidOperationException("The job already has a root process.");

        _rootCreationAttempted = true;
        StringBuilder commandLine = new StringBuilder(Quote(application) + " " + Quote(script));
        StringBuilder environmentBlock = new StringBuilder();
        foreach (string entry in environmentEntries.OrderBy(value => value, StringComparer.OrdinalIgnoreCase))
            environmentBlock.Append(entry).Append('\0');
        environmentBlock.Append('\0');
        IntPtr environmentPointer = Marshal.StringToHGlobalUni(environmentBlock.ToString());
        StartupInfo startupInfo = new StartupInfo();
        startupInfo.Size = Marshal.SizeOf(typeof(StartupInfo));
        startupInfo.Flags = 0x00000100;
        startupInfo.StdInput = GetStandardHandle(-10);
        startupInfo.StdOutput = GetStandardHandle(-11);
        startupInfo.StdError = GetStandardHandle(-12);

        ProcessInformation processInformation;
        try
        {
            bool created = CreateProcess(
                application,
                commandLine,
                IntPtr.Zero,
                IntPtr.Zero,
                true,
                CreateSuspended | CreateNewProcessGroup | CreateUnicodeEnvironment,
                environmentPointer,
                workingDirectory,
                ref startupInfo,
                out processInformation);
            if (!created)
            {
                RootCreationFailed = true;
                RootDiagnostic = "CreateProcess failed with Win32 error " + Marshal.GetLastWin32Error();
                _diagnostics.Add(RootDiagnostic);
                throw NativeError("CreateProcess");
            }
        }
        finally
        {
            Marshal.FreeHGlobal(environmentPointer);
        }

        RootProcessId = processInformation.ProcessId;
        _rootProcessHandle = processInformation.Process;
        _rootProcessHandleState = "open";
        _rootThreadHandle = processInformation.Thread;
        try
        {
            _processHandles.Add(RootProcessId, processInformation.Process);
            _rootRecord = new MediaSmokeProcessRecord { ProcessId = RootProcessId, State = "created_suspended" };
            _records.Add(_rootRecord);
        }
        catch (Exception trackingError)
        {
            RootDiagnostic = "root process tracking failed for PID " + RootProcessId +
                "; the root handle remains separately retained: " + trackingError.ToString();
            _diagnostics.Add(RootDiagnostic);
            TryTerminateUnassignedRoot(Math.Min(2000, failureGraceMilliseconds));
            throw new InvalidOperationException(RootDiagnostic, trackingError);
        }

        if (!AssignProcessToJobObject(_job, processInformation.Process))
        {
            int assignmentError = Marshal.GetLastWin32Error();
            RootDiagnostic = "AssignProcessToJobObject failed with Win32 error " + assignmentError;
            _rootRecord.Diagnostic = RootDiagnostic;
            _rootRecord.State = "assignment_failed_suspended";
            _diagnostics.Add(RootDiagnostic);
            TryTerminateUnassignedRoot(Math.Min(2000, failureGraceMilliseconds));
            throw new Win32Exception(assignmentError, "AssignProcessToJobObject failed; root was not resumed.");
        }

        _rootAssignedToJob = true;
        _rootRecord.State = "assigned_suspended";
        if (ResumeThread(_rootThreadHandle) == UInt32.MaxValue)
        {
            int resumeError = Marshal.GetLastWin32Error();
            RootDiagnostic = "ResumeThread failed with Win32 error " + resumeError;
            _rootRecord.Diagnostic = RootDiagnostic;
            _diagnostics.Add(RootDiagnostic);
            throw new Win32Exception(resumeError, "ResumeThread failed.");
        }
        _rootRecord.State = "running";
        if (CloseHandle(_rootThreadHandle))
            _rootThreadHandle = IntPtr.Zero;
        else
            _diagnostics.Add("CloseHandle(root thread) failed with Win32 error " + Marshal.GetLastWin32Error());
    }

    public bool RequestGracefulStop()
    {
        return RootProcessId != 0 && GenerateConsoleCtrlEvent(1, RootProcessId);
    }

    public void ForceStop(uint exitCode)
    {
        if (_job == IntPtr.Zero) throw new InvalidOperationException("The job object is no longer available.");
        if (!TerminateJobObject(_job, exitCode))
        {
            int error = Marshal.GetLastWin32Error();
            if (GetActiveProcessIds().Length > 0) throw new Win32Exception(error, "TerminateJobObject failed.");
        }
    }

    public uint[] GetActiveProcessIds()
    {
        HashSet<uint> active = new HashSet<uint>(GetJobActiveProcessIds());
        if (RootProcessId != 0 && !_rootAssignedToJob && !RootExited)
            active.Add(RootProcessId);
        return active.OrderBy(processId => processId).ToArray();
    }

    public uint[] GetJobActiveProcessIds()
    {
        if (_job == IntPtr.Zero) return _lastKnownActivePids.OrderBy(processId => processId).ToArray();
        int capacity = 64;
        while (capacity <= 65536)
        {
            int size = 8 + capacity * IntPtr.Size;
            IntPtr buffer = Marshal.AllocHGlobal(size);
            try
            {
                Marshal.WriteInt32(buffer, 4, capacity);
                uint returned;
                bool queried = QueryInformationJobObject(_job, JobObjectBasicProcessIdList, buffer, (uint)size, out returned);
                int error = queried ? 0 : Marshal.GetLastWin32Error();
                if (!queried && error == 234)
                {
                    int assigned = Marshal.ReadInt32(buffer, 0);
                    capacity = Math.Max(capacity * 2, assigned);
                    continue;
                }
                if (!queried) throw new Win32Exception(error, "QueryInformationJobObject(process list) failed.");

                int count = Marshal.ReadInt32(buffer, 4);
                uint[] processIds = new uint[count];
                for (int i = 0; i < count; i++)
                    processIds[i] = unchecked((uint)Marshal.ReadIntPtr(buffer, 8 + i * IntPtr.Size).ToInt64());
                _lastKnownActivePids.Clear();
                foreach (uint processId in processIds) _lastKnownActivePids.Add(processId);
                return processIds;
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }
        throw new InvalidOperationException("The media smoke process tree exceeded the PID query limit.");
    }

    public uint[] GetUnknownProcessIds()
    {
        RefreshRootStatus();
        HashSet<uint> unknown = new HashSet<uint>(_lastKnownActivePids);
        foreach (MediaSmokeProcessRecord record in _records)
        {
            if ((record.State != "exited" && record.State != "abnormally_exited") || !record.ExitCode.HasValue)
                unknown.Add(record.ProcessId);
        }
        return unknown.OrderBy(processId => processId).ToArray();
    }

    public bool TryTerminateUnassignedRoot(uint graceMilliseconds)
    {
        if (RootProcessId == 0 || _rootAssignedToJob || RootExited) return RootExited;
        if (_rootProcessHandleState != "open") return false;
        IntPtr processHandle = _rootProcessHandle;
        if (processHandle == IntPtr.Zero)
        {
            RootDiagnostic = "root process handle is unavailable; termination cannot be verified";
            _diagnostics.Add(RootDiagnostic);
            return false;
        }

        if (!TerminateProcess(processHandle, 1))
        {
            int error = Marshal.GetLastWin32Error();
            RootDiagnostic = "TerminateProcess failed with Win32 error " + error;
            if (_rootRecord != null) _rootRecord.Diagnostic = RootDiagnostic;
            _diagnostics.Add(RootDiagnostic);
        }
        uint waitResult = WaitForSingleObject(processHandle, graceMilliseconds);
        if (waitResult == WaitObject0)
        {
            uint exitCode;
            RootExited = true;
            _rootTerminationConfirmed = true;
            if (_rootRecord != null) _rootRecord.State = "exited";
            if (GetExitCodeProcess(processHandle, out exitCode))
            {
                RootExitCode = unchecked((int)exitCode);
                if (_rootRecord != null) _rootRecord.ExitCode = RootExitCode;
            }
            else
            {
                RootDiagnostic = "root exited but its exit code could not be determined";
                if (_rootRecord != null) _rootRecord.Diagnostic = RootDiagnostic;
                _diagnostics.Add(RootDiagnostic);
            }
            CloseRootThreadHandle();
            CloseRootProcessHandle();
            return true;
        }

        int waitError = waitResult == WaitFailed ? Marshal.GetLastWin32Error() : 0;
        RootDiagnostic = waitResult == WaitTimeout
            ? "root termination was not confirmed before the grace period expired"
            : "WaitForSingleObject(root) failed with Win32 error " + waitError;
        if (_rootRecord != null)
        {
            _rootRecord.State = "termination_unverified";
            _rootRecord.Diagnostic = RootDiagnostic;
        }
        _diagnostics.Add(RootDiagnostic);
        return false;
    }

    public bool Pump(int waitMilliseconds)
    {
        uint bytes;
        UIntPtr completionKey;
        IntPtr processIdPointer;
        bool received = GetQueuedCompletionStatus(_completionPort, out bytes, out completionKey, out processIdPointer, (uint)Math.Max(0, waitMilliseconds));
        if (!received)
        {
            int error = Marshal.GetLastWin32Error();
            if (error == 258) return false;
            throw new Win32Exception(error, "GetQueuedCompletionStatus failed.");
        }

        uint message = bytes;
        uint processId = unchecked((uint)processIdPointer.ToInt64());
        if (processId == 0) return true;
        if (message == JobMessageNewProcess)
        {
            MediaSmokeProcessRecord activeRecord = _records.LastOrDefault(record => record.ProcessId == processId && record.State == "running");
            if (activeRecord == null)
            {
                MediaSmokeProcessRecord record = new MediaSmokeProcessRecord { ProcessId = processId, State = "running" };
                _records.Add(record);
                IntPtr handle = OpenProcess(ProcessQueryLimitedInformation | Synchronize, false, processId);
                if (handle != IntPtr.Zero)
                    _processHandles[processId] = handle;
                else
                {
                    record.Diagnostic = "OpenProcess failed with Win32 error " + Marshal.GetLastWin32Error();
                    _diagnostics.Add("PID " + processId + ": " + record.Diagnostic);
                }
            }
            return true;
        }
        if (message == JobMessageExitProcess || message == JobMessageAbnormalExitProcess)
        {
            if (processId == RootProcessId && _rootProcessHandleState != "open")
            {
                _lastKnownActivePids.Remove(processId);
                return true;
            }
            if (processId == RootProcessId && RootExited && RootExitCode.HasValue)
            {
                _lastKnownActivePids.Remove(processId);
                return true;
            }
            MediaSmokeProcessRecord record = _records.LastOrDefault(candidate => candidate.ProcessId == processId && candidate.State == "running");
            if (record == null && processId == RootProcessId) record = _rootRecord;
            if (record == null)
            {
                record = new MediaSmokeProcessRecord { ProcessId = processId };
                _records.Add(record);
            }
            string terminalState = message == JobMessageExitProcess ? "exited" : "abnormally_exited";
            record.State = terminalState;
            IntPtr handle;
            if (_processHandles.TryGetValue(processId, out handle))
            {
                uint exitCode;
                if (GetExitCodeProcess(handle, out exitCode))
                    record.ExitCode = unchecked((int)exitCode);
                else
                {
                    record.State = "exit_code_unknown";
                    record.Diagnostic = "GetExitCodeProcess failed or returned STILL_ACTIVE after an exit notification";
                    _diagnostics.Add("PID " + processId + ": " + record.Diagnostic);
                }
                CloseProcessHandle(processId);
            }
            else
            {
                record.State = "exit_code_unknown";
                record.Diagnostic = "no process handle was available to confirm the exit code";
                _diagnostics.Add("PID " + processId + ": " + record.Diagnostic);
            }
            if (processId == RootProcessId)
            {
                RootExited = true;
                RootExitCode = record.ExitCode;
                _rootRecord = record;
                _rootTerminationConfirmed = true;
                CloseRootThreadHandle();
            }
            _lastKnownActivePids.Remove(processId);
        }
        return true;
    }

    public void RefreshRootStatus()
    {
        IntPtr handle = _rootProcessHandle;
        if (RootProcessId == 0 || RootExited || _rootProcessHandleState != "open" || handle == IntPtr.Zero) return;
        uint waitResult = WaitForSingleObject(handle, 0);
        if (waitResult == WaitObject0)
        {
            uint exitCode;
            RootExited = true;
            _rootTerminationConfirmed = true;
            if (GetExitCodeProcess(handle, out exitCode))
            {
                RootExitCode = unchecked((int)exitCode);
                if (_rootRecord != null)
                {
                    _rootRecord.ExitCode = RootExitCode;
                    _rootRecord.State = "exited";
                }
            }
            else
            {
                RootDiagnostic = "root exited but GetExitCodeProcess could not determine its exit code";
                if (_rootRecord != null)
                {
                    _rootRecord.State = "exit_code_unknown";
                    _rootRecord.Diagnostic = RootDiagnostic;
                }
                _diagnostics.Add(RootDiagnostic);
            }
            CloseRootProcessHandle();
            CloseRootThreadHandle();
            _lastKnownActivePids.Remove(RootProcessId);
        }
        else if (waitResult == WaitFailed)
        {
            RootDiagnostic = "WaitForSingleObject(root status) failed with Win32 error " + Marshal.GetLastWin32Error();
            _diagnostics.Add(RootDiagnostic);
        }
    }

    public MediaSmokeProcessRecord[] GetProcessRecords()
    {
        return _records.OrderBy(record => record.ProcessId).ToArray();
    }

    public void Dispose()
    {
        DisposeBounded(0);
    }

    public void DisposeBounded(uint waitMilliseconds)
    {
        System.Diagnostics.Stopwatch waitBudget = System.Diagnostics.Stopwatch.StartNew();
        try
        {
            if (RootProcessId != 0 && !_rootAssignedToJob && !RootExited)
            {
                uint remaining = RemainingMilliseconds(waitBudget, waitMilliseconds);
                if (remaining > 0) TryTerminateUnassignedRoot(Math.Min(remaining, 1000));
            }

            if (_job != IntPtr.Zero)
            {
                bool shouldTerminateJob = true;
                try
                {
                    shouldTerminateJob = GetJobActiveProcessIds().Length > 0;
                    BasicAccountingInformation accounting;
                    if (TryGetJobAccounting(out accounting) && accounting.ActiveProcesses > 0)
                        shouldTerminateJob = true;
                }
                catch (Exception error)
                {
                    _diagnostics.Add("Job PID snapshot failed during dispose: " + error.GetType().Name);
                }
                if (shouldTerminateJob && !TerminateJobObject(_job, 124))
                    _diagnostics.Add("TerminateJobObject(dispose) failed with Win32 error " + Marshal.GetLastWin32Error());

                while (RemainingMilliseconds(waitBudget, waitMilliseconds) > 0)
                {
                    BasicAccountingInformation accounting;
                    if (!TryGetJobAccounting(out accounting)) break;
                    if (accounting.ActiveProcesses == 0) break;
                    uint pause = Math.Min(50, RemainingMilliseconds(waitBudget, waitMilliseconds));
                    if (pause == 0) break;
                    System.Threading.Thread.Sleep((int)pause);
                }
            }

            foreach (uint processId in _processHandles.Keys.ToArray())
            {
                if (processId == RootProcessId && _rootProcessHandleState != "open") continue;
                IntPtr processHandle;
                if (!_processHandles.TryGetValue(processId, out processHandle)) continue;
                uint remaining = RemainingMilliseconds(waitBudget, waitMilliseconds);
                if (remaining == 0) continue;
                uint waitResult = WaitForSingleObject(processHandle, remaining);
                if (waitResult == WaitObject0)
                    RecordConfirmedExit(processId, processHandle);
                else if (waitResult == WaitFailed)
                    _diagnostics.Add("WaitForSingleObject(PID " + processId + ") failed with Win32 error " + Marshal.GetLastWin32Error());
            }
            if (_rootProcessHandleState == "open" &&
                _rootProcessHandle != IntPtr.Zero &&
                !_processHandles.ContainsKey(RootProcessId))
            {
                uint remaining = RemainingMilliseconds(waitBudget, waitMilliseconds);
                if (remaining > 0)
                {
                    uint waitResult = WaitForSingleObject(_rootProcessHandle, remaining);
                    if (waitResult == WaitObject0)
                        RecordConfirmedExit(RootProcessId, _rootProcessHandle);
                    else if (waitResult == WaitFailed)
                        _diagnostics.Add("WaitForSingleObject(root fallback handle) failed with Win32 error " + Marshal.GetLastWin32Error());
                }
            }

            while (_job != IntPtr.Zero && RemainingMilliseconds(waitBudget, waitMilliseconds) > 0)
            {
                if (!HasUnreconciledProcessRecords) break;
                uint remaining = RemainingMilliseconds(waitBudget, waitMilliseconds);
                if (remaining == 0) break;
                Pump((int)Math.Min(50, remaining));
            }
        }
        catch (Exception error)
        {
            _diagnostics.Add("bounded dispose supervision failed: " + error.GetType().Name);
        }
        finally
        {
            try
            {
                if (_job != IntPtr.Zero) CaptureFinalAccounting();
            }
            catch (Exception error)
            {
                _diagnostics.Add("job accounting capture failed during dispose: " + error.GetType().Name);
            }

            try
            {
                if (_job != IntPtr.Zero)
                {
                    if (CloseHandle(_job))
                    {
                        _job = IntPtr.Zero;
                    }
                    else
                        _diagnostics.Add("CloseHandle(job) failed with Win32 error " + Marshal.GetLastWin32Error());
                }
            }
            catch (Exception error)
            {
                _diagnostics.Add("job handle disposal failed: " + error.GetType().Name);
            }

            try
            {
                if (_completionPort != IntPtr.Zero)
                {
                    if (CloseHandle(_completionPort))
                        _completionPort = IntPtr.Zero;
                    else
                        _diagnostics.Add("CloseHandle(completion port) failed with Win32 error " + Marshal.GetLastWin32Error());
                }
            }
            catch (Exception error)
            {
                _diagnostics.Add("completion-port handle disposal failed: " + error.GetType().Name);
            }

            if (_rootAssignedToJob || RootExited)
            {
                foreach (uint processId in _processHandles.Keys.ToArray())
                {
                    if (processId == RootProcessId) continue;
                    try
                    {
                        CloseProcessHandle(processId);
                    }
                    catch (Exception error)
                    {
                        _diagnostics.Add("process handle disposal failed for PID " + processId + ": " + error.GetType().Name);
                    }
                }
                try
                {
                    CloseRootThreadHandle();
                    if (_rootAssignedToJob || RootExited) CloseRootProcessHandle();
                }
                catch (Exception error)
                {
                    _diagnostics.Add("root thread handle disposal failed: " + error.GetType().Name);
                }
            }

            IsDisposed = _job == IntPtr.Zero &&
                _completionPort == IntPtr.Zero &&
                _processHandles.Count == 0 &&
                _rootThreadHandle == IntPtr.Zero &&
                _rootProcessHandle == IntPtr.Zero &&
                (_rootProcessHandleState == "not_created" || _rootProcessHandleState == "released");
        }
    }

    private static uint RemainingMilliseconds(System.Diagnostics.Stopwatch stopwatch, uint totalMilliseconds)
    {
        long remaining = (long)totalMilliseconds - stopwatch.ElapsedMilliseconds;
        if (remaining <= 0) return 0;
        return (uint)Math.Min(UInt32.MaxValue, remaining);
    }

    private bool TryGetJobAccounting(out BasicAccountingInformation accounting)
    {
        accounting = new BasicAccountingInformation();
        if (_job == IntPtr.Zero)
        {
            if (!_finalAccountingKnown) return false;
            accounting.TotalProcesses = _finalTotalProcesses;
            accounting.ActiveProcesses = _finalActiveProcesses;
            accounting.TotalTerminatedProcesses = _finalTerminatedProcesses;
            return true;
        }

        IntPtr buffer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(BasicAccountingInformation)));
        try
        {
            uint returned;
            if (!QueryInformationJobObject(
                _job,
                JobObjectBasicAccountingInformation,
                buffer,
                (uint)Marshal.SizeOf(typeof(BasicAccountingInformation)),
                out returned))
            {
                _diagnostics.Add("QueryInformationJobObject(accounting) failed with Win32 error " + Marshal.GetLastWin32Error());
                return false;
            }
            accounting = (BasicAccountingInformation)Marshal.PtrToStructure(buffer, typeof(BasicAccountingInformation));
            return true;
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private void CaptureFinalAccounting()
    {
        BasicAccountingInformation accounting;
        if (!TryGetJobAccounting(out accounting)) return;
        _finalTotalProcesses = accounting.TotalProcesses;
        _finalActiveProcesses = accounting.ActiveProcesses;
        _finalTerminatedProcesses = accounting.TotalTerminatedProcesses;
        _finalAccountingKnown = true;
        if (accounting.ActiveProcesses == 0) _lastKnownActivePids.Clear();
    }

    private void RecordConfirmedExit(uint processId, IntPtr processHandle)
    {
        if (processId == RootProcessId && _rootProcessHandleState != "open") return;
        MediaSmokeProcessRecord record = _records.LastOrDefault(candidate => candidate.ProcessId == processId);
        if (record == null)
        {
            record = new MediaSmokeProcessRecord { ProcessId = processId };
            _records.Add(record);
        }

        uint exitCode;
        if (GetExitCodeProcess(processHandle, out exitCode))
        {
            record.ExitCode = unchecked((int)exitCode);
            record.State = "exited";
        }
        else
        {
            record.State = "exit_code_unknown";
            record.Diagnostic = "process signaled but its exit code could not be determined";
            _diagnostics.Add("PID " + processId + ": " + record.Diagnostic);
        }

        if (processId == RootProcessId)
        {
            RootExited = true;
            _rootTerminationConfirmed = true;
            RootExitCode = record.ExitCode;
            _rootRecord = record;
            CloseRootThreadHandle();
        }
        _lastKnownActivePids.Remove(processId);
    }

    private void CloseProcessHandle(uint processId)
    {
        if (processId == RootProcessId)
        {
            CloseRootProcessHandle();
            return;
        }
        IntPtr handle;
        if (!_processHandles.TryGetValue(processId, out handle)) return;
        if (CloseHandle(handle))
            _processHandles.Remove(processId);
        else
            _diagnostics.Add("CloseHandle(PID " + processId + ") failed with Win32 error " + Marshal.GetLastWin32Error());
    }

    private void CloseRootProcessHandle()
    {
        if (_rootProcessHandleState != "open") return;
        IntPtr handle = _rootProcessHandle;
        if (handle == IntPtr.Zero)
        {
            MarkRootProcessHandleReleaseUnconfirmed("root process handle state is open but its owned handle value is unavailable");
            return;
        }
        bool closed;
        try
        {
            closed = CloseHandle(handle);
        }
        catch (Exception error)
        {
            MarkRootProcessHandleReleaseUnconfirmed(
                "CloseHandle(root process) threw " + error.GetType().Name + ": " + error.Message);
            return;
        }
        if (closed)
        {
            _rootProcessHandle = IntPtr.Zero;
            _rootProcessHandleState = "released";
            IntPtr trackedHandle;
            if (_processHandles.TryGetValue(RootProcessId, out trackedHandle) && trackedHandle == handle)
                _processHandles.Remove(RootProcessId);
        }
        else
        {
            int closeError = Marshal.GetLastWin32Error();
            MarkRootProcessHandleReleaseUnconfirmed(
                "CloseHandle(root process) failed with Win32 error " + closeError);
        }
    }

    private void MarkRootProcessHandleReleaseUnconfirmed(string diagnostic)
    {
        _rootProcessHandleState = "release-unconfirmed";
        _processHandles.Remove(RootProcessId);
        _diagnostics.Add(diagnostic);
    }

    private void CloseRootThreadHandle()
    {
        if (_rootThreadHandle == IntPtr.Zero) return;
        if (CloseHandle(_rootThreadHandle))
            _rootThreadHandle = IntPtr.Zero;
        else
            _diagnostics.Add("CloseHandle(root thread) failed with Win32 error " + Marshal.GetLastWin32Error());
    }

    private static IntPtr GetStandardHandle(int id)
    {
        return NativeGetStdHandle(id);
    }

    [DllImport("kernel32.dll", EntryPoint = "GetStdHandle", SetLastError = true)]
    private static extern IntPtr NativeGetStdHandle(int standardHandle);

    private static string Quote(string value)
    {
        StringBuilder result = new StringBuilder("\"");
        int backslashes = 0;
        foreach (char character in value)
        {
            if (character == '\\')
            {
                backslashes++;
                continue;
            }
            if (character == '"')
            {
                result.Append('\\', backslashes * 2 + 1).Append(character);
                backslashes = 0;
                continue;
            }
            result.Append('\\', backslashes).Append(character);
            backslashes = 0;
        }
        result.Append('\\', backslashes * 2).Append('"');
        return result.ToString();
    }

    private static Win32Exception NativeError(string operation)
    {
        return new Win32Exception(Marshal.GetLastWin32Error(), operation + " failed.");
    }
}

public sealed class MediaSmokeOwnedDirectoryOpenResult
{
    public MediaSmokeOwnedDirectoryLease Lease { get; set; }
    public string State { get; set; }
    public string Diagnostic { get; set; }
}

public sealed class MediaSmokeOwnedDirectoryLease : IDisposable
{
    private const uint FileListDirectory = 0x00000001;
    private const uint FileAddFile = 0x00000002;
    private const uint FileReadData = 0x00000001;
    private const uint FileWriteData = 0x00000002;
    private const uint FileReadAttributes = 0x00000080;
    private const uint Synchronize = 0x00100000;
    private const uint FileShareRead = 0x00000001;
    private const uint FileShareWrite = 0x00000002;
    private const uint FileFlagOpenReparsePoint = 0x00200000;
    private const uint FileFlagBackupSemantics = 0x02000000;
    private const uint FileAttributeNormal = 0x00000080;
    private const uint FileAttributeDirectory = 0x00000010;
    private const uint FileAttributeReparsePoint = 0x00000400;
    private const uint FileOpen = 1;
    private const uint FileCreate = 2;
    private const uint FileNonDirectory = 0x00000040;
    private const uint FileSynchronousIoNonAlert = 0x00000020;
    private const uint ObjectCaseInsensitive = 0x00000040;
    private const uint ObjectDontReparse = 0x00001000;
    private const int StatusObjectNameNotFound = unchecked((int)0xC0000034);
    private const int StatusObjectPathNotFound = unchecked((int)0xC000003A);
    private const int StatusObjectNameCollision = unchecked((int)0xC0000035);
    private IntPtr _directoryHandle;
    private IntPtr _proofHandle;
    private uint _volumeSerial;
    private uint _fileIndexHigh;
    private uint _fileIndexLow;
    private bool _identityCaptured;
    private bool _disposed;

    [StructLayout(LayoutKind.Sequential)]
    private struct FileTime
    {
        public uint Low;
        public uint High;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ByHandleFileInformation
    {
        public uint FileAttributes;
        public FileTime CreationTime;
        public FileTime LastAccessTime;
        public FileTime LastWriteTime;
        public uint VolumeSerialNumber;
        public uint FileSizeHigh;
        public uint FileSizeLow;
        public uint NumberOfLinks;
        public uint FileIndexHigh;
        public uint FileIndexLow;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct UnicodeString
    {
        public ushort Length;
        public ushort MaximumLength;
        public IntPtr Buffer;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ObjectAttributes
    {
        public int Length;
        public IntPtr RootDirectory;
        public IntPtr ObjectName;
        public uint Attributes;
        public IntPtr SecurityDescriptor;
        public IntPtr SecurityQualityOfService;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoStatusBlock
    {
        public IntPtr Status;
        public IntPtr Information;
    }

    public string State { get; private set; }
    public string Diagnostic { get; private set; }
    public bool ReportWritten { get; private set; }
    public bool HandleReleased { get; private set; }

    private MediaSmokeOwnedDirectoryLease(IntPtr directoryHandle)
    {
        _directoryHandle = directoryHandle;
    }

    public static MediaSmokeOwnedDirectoryOpenResult Open(string rootPath, string expectedProof)
    {
        MediaSmokeOwnedDirectoryOpenResult result = new MediaSmokeOwnedDirectoryOpenResult();
        if (String.IsNullOrEmpty(rootPath) || String.IsNullOrEmpty(expectedProof))
        {
            result.State = "invalid_arguments";
            result.Diagnostic = "root path or ownership proof was empty";
            return result;
        }

        IntPtr directoryHandle = CreateFileW(
            rootPath,
            FileListDirectory | FileAddFile | FileReadAttributes | Synchronize,
            FileShareRead | FileShareWrite,
            IntPtr.Zero,
            3,
            FileFlagBackupSemantics | FileFlagOpenReparsePoint,
            IntPtr.Zero);
        if (directoryHandle == new IntPtr(-1))
        {
            result.State = "root_open_failed";
            result.Diagnostic = "CreateFileW(root handle) failed with Win32 error " + Marshal.GetLastWin32Error();
            return result;
        }

        MediaSmokeOwnedDirectoryLease lease = new MediaSmokeOwnedDirectoryLease(directoryHandle);
        result.Lease = lease;
        try
        {
            if (!lease.ConfirmRootIdentity())
            {
                result.State = lease.State;
                result.Diagnostic = lease.Diagnostic;
            }
            else if (!lease.OpenAndVerifyProof(expectedProof))
            {
                result.State = lease.State;
                result.Diagnostic = lease.Diagnostic;
            }
            else
            {
                result.State = "ownership_verified";
                return result;
            }
        }
        catch (Exception error)
        {
            lease.AddDiagnostic("root ownership verification failed: " + error.ToString());
            result.State = "ownership_verification_failed";
            result.Diagnostic = lease.Diagnostic;
        }

        lease.Dispose();
        result.Diagnostic = JoinDiagnostics(result.Diagnostic, lease.Diagnostic);
        result.Lease = null;
        return result;
    }

    public bool WriteReport(string reportJson)
    {
        if (_disposed || _directoryHandle == IntPtr.Zero || _proofHandle == IntPtr.Zero)
        {
            State = "lease_not_held";
            AddDiagnostic("report write refused because ownership lease is not held");
            return false;
        }
        if (String.IsNullOrEmpty(reportJson))
        {
            State = "invalid_report";
            AddDiagnostic("report content was empty");
            return false;
        }
        if (!ConfirmRootIdentity()) return false;

        byte[] reportBytes = Encoding.UTF8.GetBytes(reportJson);
        IntPtr reportHandle = IntPtr.Zero;
        bool writeSucceeded = false;
        try
        {
            IntPtr createdReportHandle = IntPtr.Zero;
            int status = OpenRelative(
                _directoryHandle,
                "supervision-report.json",
                FileWriteData | FileReadAttributes | Synchronize,
                0,
                FileAttributeNormal,
                FileCreate,
                FileNonDirectory | FileSynchronousIoNonAlert | FileFlagOpenReparsePoint,
                out createdReportHandle);
            if (status == StatusObjectNameCollision)
            {
                State = "report_exists";
                AddDiagnostic("report already exists; no overwrite was attempted");
                return false;
            }
            if (status < 0)
            {
                State = "report_create_failed";
                AddDiagnostic("relative report creation failed with NTSTATUS 0x" + status.ToString("X8"));
                return false;
            }
            reportHandle = createdReportHandle;

            int offset = 0;
            while (offset < reportBytes.Length)
            {
                int count = Math.Min(65536, reportBytes.Length - offset);
                byte[] chunk = new byte[count];
                Buffer.BlockCopy(reportBytes, offset, chunk, 0, count);
                uint written;
                if (!WriteFile(reportHandle, chunk, (uint)count, out written, IntPtr.Zero) || written == 0)
                {
                    State = "report_write_failed";
                    AddDiagnostic("WriteFile(report) failed with Win32 error " + Marshal.GetLastWin32Error());
                    return false;
                }
                offset += (int)written;
            }
            if (!FlushFileBuffers(reportHandle))
            {
                State = "report_flush_failed";
                AddDiagnostic("FlushFileBuffers(report) failed with Win32 error " + Marshal.GetLastWin32Error());
                return false;
            }
            if (!ConfirmRootIdentity()) return false;
            ReportWritten = true;
            State = "written";
            writeSucceeded = true;
        }
        catch (Exception error)
        {
            State = "report_write_failed";
            AddDiagnostic("report write failed: " + error.ToString());
            return false;
        }
        finally
        {
            if (reportHandle != IntPtr.Zero && !CloseHandle(reportHandle))
            {
                State = "report_handle_close_failed";
                AddDiagnostic("CloseHandle(report) failed with Win32 error " + Marshal.GetLastWin32Error());
                ReportWritten = false;
            }
        }
        return writeSucceeded && ReportWritten;
    }

    private bool ConfirmRootIdentity()
    {
        ByHandleFileInformation information;
        if (_directoryHandle == IntPtr.Zero || !GetFileInformationByHandle(_directoryHandle, out information))
        {
            State = "root_identity_unconfirmed";
            AddDiagnostic("GetFileInformationByHandle(root) failed with Win32 error " + Marshal.GetLastWin32Error());
            return false;
        }
        if ((information.FileAttributes & FileAttributeDirectory) == 0 ||
            (information.FileAttributes & FileAttributeReparsePoint) != 0)
        {
            State = "root_identity_unconfirmed";
            AddDiagnostic("held root is not a plain directory");
            return false;
        }
        if (!_identityCaptured)
        {
            _volumeSerial = information.VolumeSerialNumber;
            _fileIndexHigh = information.FileIndexHigh;
            _fileIndexLow = information.FileIndexLow;
            _identityCaptured = true;
            State = "root_identity_confirmed";
            return true;
        }
        bool sameIdentity = _volumeSerial == information.VolumeSerialNumber &&
            _fileIndexHigh == information.FileIndexHigh &&
            _fileIndexLow == information.FileIndexLow;
        if (!sameIdentity)
        {
            State = "root_identity_changed";
            AddDiagnostic("held root file identity changed");
        }
        return sameIdentity;
    }

    private bool OpenAndVerifyProof(string expectedProof)
    {
        IntPtr proofHandle = IntPtr.Zero;
        int status = OpenRelative(
            _directoryHandle,
            ".media-smoke-owner",
            FileReadData | FileReadAttributes | Synchronize,
            FileShareRead,
            0,
            FileOpen,
            FileNonDirectory | FileSynchronousIoNonAlert | FileFlagOpenReparsePoint,
            out proofHandle);
        if (status == StatusObjectNameNotFound || status == StatusObjectPathNotFound)
        {
            State = "proof_missing";
            AddDiagnostic("relative ownership proof was not found");
            return false;
        }
        if (status < 0)
        {
            State = "proof_open_failed";
            AddDiagnostic("relative ownership proof open failed with NTSTATUS 0x" + status.ToString("X8"));
            return false;
        }
        _proofHandle = proofHandle;

        ByHandleFileInformation proofInformation;
        if (!GetFileInformationByHandle(_proofHandle, out proofInformation))
        {
            State = "proof_identity_unconfirmed";
            AddDiagnostic("GetFileInformationByHandle(proof) failed with Win32 error " + Marshal.GetLastWin32Error());
            return false;
        }
        if ((proofInformation.FileAttributes & (FileAttributeDirectory | FileAttributeReparsePoint)) != 0)
        {
            State = "proof_identity_unconfirmed";
            AddDiagnostic("ownership proof is not a plain file");
            return false;
        }

        byte[] buffer = new byte[256];
        uint bytesRead;
        if (!ReadFile(_proofHandle, buffer, (uint)buffer.Length, out bytesRead, IntPtr.Zero))
        {
            State = "proof_read_failed";
            AddDiagnostic("ReadFile(proof) failed with Win32 error " + Marshal.GetLastWin32Error());
            return false;
        }
        string actualProof = Encoding.ASCII.GetString(buffer, 0, (int)bytesRead);
        if (!String.Equals(actualProof, expectedProof + "\n", StringComparison.Ordinal))
        {
            State = "proof_mismatch";
            AddDiagnostic("ownership proof did not match this launcher invocation");
            return false;
        }
        return true;
    }

    private static int OpenRelative(
        IntPtr rootHandle,
        string name,
        uint desiredAccess,
        uint shareAccess,
        uint fileAttributes,
        uint disposition,
        uint createOptions,
        out IntPtr fileHandle)
    {
        IntPtr nameBuffer = Marshal.StringToHGlobalUni(name);
        IntPtr unicodePointer = IntPtr.Zero;
        try
        {
            UnicodeString unicodeName = new UnicodeString();
            unicodeName.Length = checked((ushort)(name.Length * 2));
            unicodeName.MaximumLength = checked((ushort)(unicodeName.Length + 2));
            unicodeName.Buffer = nameBuffer;
            unicodePointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UnicodeString)));
            Marshal.StructureToPtr(unicodeName, unicodePointer, false);

            ObjectAttributes attributes = new ObjectAttributes();
            attributes.Length = Marshal.SizeOf(typeof(ObjectAttributes));
            attributes.RootDirectory = rootHandle;
            attributes.ObjectName = unicodePointer;
            attributes.Attributes = ObjectCaseInsensitive | ObjectDontReparse;
            IoStatusBlock ioStatus;
            return NtCreateFile(
                out fileHandle,
                desiredAccess,
                ref attributes,
                out ioStatus,
                IntPtr.Zero,
                fileAttributes,
                shareAccess,
                disposition,
                createOptions,
                IntPtr.Zero,
                0);
        }
        finally
        {
            if (unicodePointer != IntPtr.Zero) Marshal.FreeHGlobal(unicodePointer);
            Marshal.FreeHGlobal(nameBuffer);
        }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        bool released = true;
        if (_proofHandle != IntPtr.Zero)
        {
            if (CloseHandle(_proofHandle))
                _proofHandle = IntPtr.Zero;
            else
            {
                released = false;
                AddDiagnostic("CloseHandle(ownership proof) failed with Win32 error " + Marshal.GetLastWin32Error());
            }
        }
        if (_directoryHandle != IntPtr.Zero)
        {
            if (CloseHandle(_directoryHandle))
                _directoryHandle = IntPtr.Zero;
            else
            {
                released = false;
                AddDiagnostic("CloseHandle(root directory) failed with Win32 error " + Marshal.GetLastWin32Error());
            }
        }
        HandleReleased = released;
        if (!released) State = "handle_release_unconfirmed";
        else if (State == "root_identity_confirmed" || State == "written") State = "disposed";
    }

    private void AddDiagnostic(string diagnostic)
    {
        Diagnostic = JoinDiagnostics(Diagnostic, diagnostic);
    }

    private static string JoinDiagnostics(string first, string second)
    {
        if (String.IsNullOrEmpty(first)) return second;
        if (String.IsNullOrEmpty(second)) return first;
        return first + "; " + second;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateFileW(
        string fileName,
        uint desiredAccess,
        uint shareMode,
        IntPtr securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandle(IntPtr fileHandle, out ByHandleFileInformation information);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool ReadFile(IntPtr fileHandle, byte[] buffer, uint bytesToRead, out uint bytesRead, IntPtr overlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool WriteFile(IntPtr fileHandle, byte[] buffer, uint bytesToWrite, out uint bytesWritten, IntPtr overlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool FlushFileBuffers(IntPtr fileHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("ntdll.dll")]
    private static extern int NtCreateFile(
        out IntPtr fileHandle,
        uint desiredAccess,
        ref ObjectAttributes objectAttributes,
        out IoStatusBlock ioStatusBlock,
        IntPtr allocationSize,
        uint fileAttributes,
        uint shareAccess,
        uint createDisposition,
        uint createOptions,
        IntPtr extendedAttributes,
        uint extendedAttributesLength);
}
'@

if (-not ('MediaSmokeProcessJob' -as [type])) {
  Add-Type -TypeDefinition $nativeSource -Language CSharp
}

$nodeCommand = Get-Command node.exe -CommandType Application -ErrorAction Stop
$nodePath = $nodeCommand.Source
$nodeDirectory = Split-Path -Parent $nodePath
$scriptPath = (Resolve-Path (Join-Path $PSScriptRoot 'media-smoke.mjs')).Path
$workingDirectory = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$system32 = Join-Path $env:SystemRoot 'System32'
$powershellDirectory = Join-Path $system32 'WindowsPowerShell\v1.0'
$powershellDirectory = (Resolve-Path $powershellDirectory).Path
$candidateRoot = Join-Path ([IO.Path]::GetFullPath($env:TEMP)) ('bevhub-media-smoke-' + [guid]::NewGuid().ToString('D'))
$shutdownRequestPath = Join-Path $candidateRoot 'shutdown-request.json'
$rootProof = [guid]::NewGuid().ToString('N')
$environmentEntries = @(
  "SystemRoot=$env:SystemRoot",
  "WINDIR=$env:SystemRoot",
  "TEMP=$env:TEMP",
  "TMP=$env:TMP",
  "PATH=$powershellDirectory;$system32;$nodeDirectory",
  'PATHEXT=.COM;.EXE;.BAT;.CMD',
  'MEDIA_SMOKE_LAUNCHER=1',
  "MEDIA_SMOKE_DEADLINE_UTC_MS=$deadlineAtMs",
  "MEDIA_SMOKE_SHUTDOWN_GRACE_MS=$shutdownGraceMs",
  "MEDIA_SMOKE_VERIFY_GRACE_MS=$verifyGraceMs",
  "MEDIA_SMOKE_DISPOSABLE_ROOT=$candidateRoot",
  "MEDIA_SMOKE_ROOT_PROOF=$rootProof"
)

$script:cancelRequested = $false
$cancelHandler = [System.ConsoleCancelEventHandler]{
  param($sender, $eventArgs)
  $eventArgs.Cancel = $true
  $script:cancelRequested = $true
}
[Console]::add_CancelKeyPress($cancelHandler)

$supervisor = $null
$supervisorCreationState = 'not_started'
$supervisorCreationDiagnostic = $null
$supervisorDisposeState = 'not_attempted'
$supervisorDisposeDiagnostic = $null
$launcherDiagnostic = $null
$reason = 'launcher_error'
$gracefulRequested = $false
$gracefulRequestSucceeded = $false
$shutdownRequestObserved = $false
$forced = $false
$forceRequestedAtUtc = $null
$activePidsBeforeForce = @()
$activePidsAfterStop = @()
$nodeExitCode = $null
$terminationVerified = $false
$finalExitCode = 1
$rootOwnedThisRun = $false
$rootLease = $null
$rootLeaseDiagnostic = $null
$rootHandleReleased = $false

try {
  $supervisorCreationState = 'in_progress'
  $supervisor = New-Object MediaSmokeProcessJob
  if ($null -eq $supervisor) {
    throw [InvalidOperationException]::new('MediaSmokeProcessJob construction returned no instance.')
  }
  $supervisorCreationState = 'created'
  if ($stopwatch.ElapsedMilliseconds -ge $timeoutMs) {
    throw [TimeoutException]::new('The absolute media smoke deadline elapsed before Node startup.')
  }
  $startupCleanupBudget = [uint][Math]::Max(0, $timeoutMs - $stopwatch.ElapsedMilliseconds)
  $supervisor.Start($nodePath, $scriptPath, $workingDirectory, $environmentEntries, $startupCleanupBudget)
  $nodePid = $supervisor.RootProcessId

  while ($true) {
    $elapsedMs = [long]$stopwatch.ElapsedMilliseconds
    $supervisor.RefreshRootStatus()
    $activePids = @($supervisor.GetActiveProcessIds())
    if ($activePids.Count -eq 0) {
      while ($supervisor.Pump(0)) { }
      $supervisor.RefreshRootStatus()
      $activePids = @($supervisor.GetActiveProcessIds())
    }
    if ($activePids.Count -eq 0) {
      if ($supervisor.HasUnreconciledProcessRecords -and $elapsedMs -lt $timeoutMs) {
        $supervisor.Pump([int][Math]::Min(50, $timeoutMs - $elapsedMs)) | Out-Null
        continue
      }
      $terminationVerified = $supervisor.TerminationVerified
      if (-not $terminationVerified) {
        $reason = 'process_state_unknown'
        $finalExitCode = 1
      }
      break
    }

    if ($script:cancelRequested -and -not $gracefulRequested) {
      $reason = 'cancelled'
      $gracefulRequested = $true
      $gracefulRequestSucceeded = $supervisor.RequestGracefulStop()
      $forceStopAfterMs = [Math]::Min($forceStopAfterMs, $elapsedMs + $shutdownGraceMs)
    } elseif ((Test-Path -LiteralPath $shutdownRequestPath -PathType Leaf) -and -not $gracefulRequested) {
      $reason = 'harness_requested_shutdown'
      $shutdownRequestObserved = $true
      $gracefulRequested = $true
      $gracefulRequestSucceeded = $supervisor.RequestGracefulStop()
      $forceStopAfterMs = [Math]::Min($forceStopAfterMs, $elapsedMs + $shutdownGraceMs)
    } elseif ($elapsedMs -ge $gracefulStopAfterMs -and -not $gracefulRequested) {
      $reason = 'deadline_exceeded'
      $gracefulRequested = $true
      $gracefulRequestSucceeded = $supervisor.RequestGracefulStop()
    } elseif ($supervisor.RootExited -and $activePids.Count -gt 0 -and -not $gracefulRequested) {
      $reason = 'child_processes_outlived_node'
      $gracefulRequested = $true
      $gracefulRequestSucceeded = $supervisor.RequestGracefulStop()
      $forceStopAfterMs = [Math]::Min($forceStopAfterMs, $elapsedMs + $shutdownGraceMs)
    }

    if ($supervisor.RootExited -and $supervisor.RootExitCode -ne 0 -and $reason -eq 'launcher_error') {
      $reason = 'harness_failed'
    }

    if (-not $forced -and $elapsedMs -ge $forceStopAfterMs -and $activePids.Count -gt 0) {
      $activePidsBeforeForce = $activePids
      $forced = $true
      $verificationStopAfterMs = [Math]::Min($timeoutMs, $elapsedMs + $verifyGraceMs)
      $forceRequestedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
      $supervisor.ForceStop(124)
    }

    if ($forced -and $elapsedMs -ge $verificationStopAfterMs) {
      $activePidsAfterStop = @($supervisor.GetActiveProcessIds())
      $terminationVerified = $supervisor.TerminationVerified
      if (-not $terminationVerified) {
        $reason = 'process_termination_unverified'
        $finalExitCode = 1
      }
      break
    }

    if ($elapsedMs -ge $timeoutMs) {
      $activePidsAfterStop = @($supervisor.GetActiveProcessIds())
      $terminationVerified = $supervisor.TerminationVerified
      if (-not $terminationVerified) {
        $reason = 'process_termination_unverified'
        $finalExitCode = 1
      }
      break
    }

    $waitUntilMs = if ($forced) { $verificationStopAfterMs } elseif ($gracefulRequested) { $forceStopAfterMs } else { $gracefulStopAfterMs }
    $waitMs = [int][Math]::Max(1, [Math]::Min(100, $waitUntilMs - $elapsedMs))
    $supervisor.Pump($waitMs) | Out-Null
  }

  if ($null -ne $supervisor.RootExitCode) {
    $nodeExitCode = $supervisor.RootExitCode
  } elseif ($supervisor.RootExited) {
    $nodeExitCode = -1
  }
  if ($terminationVerified) {
    $activePidsAfterStop = @()
    if ($reason -eq 'launcher_error') {
      $reason = if ($nodeExitCode -eq 0) { 'completed' } else { 'harness_failed' }
    }
    if ($reason -eq 'completed' -and $nodeExitCode -eq 0 -and -not $forced) {
      $finalExitCode = 0
    } else {
      $finalExitCode = 1
    }
  }
} catch {
  $reason = if ($script:cancelRequested) { 'cancelled' } else { 'launcher_error' }
  $finalExitCode = 1
  $launcherDiagnostic = $_.Exception.ToString()
  if ($supervisorCreationState -eq 'in_progress') {
    $supervisorCreationState = 'creation_incomplete'
    $supervisorCreationDiagnostic = $launcherDiagnostic
  }
  [Console]::Error.WriteLine("[MEDIA SMOKE] launcher supervision failed: $launcherDiagnostic")
} finally {
  if ($null -ne $supervisor) {
    try {
      $activePidsAfterStop = @($supervisor.GetActiveProcessIds())
      $cleanupStopAfterMs = [Math]::Min($timeoutMs, $stopwatch.ElapsedMilliseconds + $shutdownGraceMs)
      if ($activePidsAfterStop.Count -gt 0) {
        if (-not $gracefulRequested) {
          $gracefulRequested = $true
          $gracefulRequestSucceeded = $supervisor.RequestGracefulStop()
        }
        while ($supervisor.GetActiveProcessIds().Length -gt 0 -and $stopwatch.ElapsedMilliseconds -lt $cleanupStopAfterMs) {
          $remaining = $cleanupStopAfterMs - $stopwatch.ElapsedMilliseconds
          if ($supervisor.RootProcessId -ne 0 -and -not $supervisor.RootAssignedToJob -and -not $supervisor.RootExited) {
            $supervisor.TryTerminateUnassignedRoot([uint][Math]::Min(500, $remaining)) | Out-Null
          } else {
            $supervisor.Pump([int][Math]::Max(1, [Math]::Min(100, $remaining))) | Out-Null
          }
        }
        $activePidsAfterStop = @($supervisor.GetActiveProcessIds())
        $jobActivePids = @($supervisor.GetJobActiveProcessIds())
        if ($jobActivePids.Count -gt 0 -and -not $forced) {
          $activePidsBeforeForce = $activePidsAfterStop
          $forced = $true
          $forceRequestedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
          $supervisor.ForceStop(124)
        }
        $verificationStopAfterMs = [Math]::Min($timeoutMs, $stopwatch.ElapsedMilliseconds + $verifyGraceMs)
        while ($supervisor.GetActiveProcessIds().Length -gt 0 -and $stopwatch.ElapsedMilliseconds -lt $verificationStopAfterMs) {
          $remaining = $verificationStopAfterMs - $stopwatch.ElapsedMilliseconds
          if ($supervisor.RootProcessId -ne 0 -and -not $supervisor.RootAssignedToJob -and -not $supervisor.RootExited) {
            $supervisor.TryTerminateUnassignedRoot([uint][Math]::Min(500, $remaining)) | Out-Null
          } else {
            $supervisor.Pump([int][Math]::Max(1, [Math]::Min(100, $remaining))) | Out-Null
          }
        }
        $activePidsAfterStop = @($supervisor.GetActiveProcessIds())
      }
      $supervisor.RefreshRootStatus()
      $terminationVerified = $supervisor.TerminationVerified
      if (-not $terminationVerified -and $reason -eq 'launcher_error') {
        $reason = 'process_termination_unverified'
      }
    } catch {
      $terminationVerified = $false
      $reason = 'process_termination_unverified'
      [Console]::Error.WriteLine("[MEDIA SMOKE] process-tree verification failed: $($_.Exception.GetType().Name)")
    } finally {
      try {
        $remainingDeadlineMs = [Math]::Max(0, $timeoutMs - $stopwatch.ElapsedMilliseconds)
        $supervisor.DisposeBounded([uint]$remainingDeadlineMs)
        $supervisor.RefreshRootStatus()
        $terminationVerified = $supervisor.TerminationVerified
        $activePidsAfterStop = @($supervisor.GetActiveProcessIds())
        if ($null -ne $supervisor.RootExitCode) {
          $nodeExitCode = $supervisor.RootExitCode
        } elseif ($supervisor.RootExited) {
          $nodeExitCode = -1
        }
        if (-not $terminationVerified) {
          if ($reason -eq 'completed' -or $reason -eq 'launcher_error') {
            $reason = 'process_termination_unverified'
          }
          $finalExitCode = 1
        }
      } catch {
        $terminationVerified = $false
        $reason = 'process_termination_unverified'
        $supervisorDisposeDiagnostic = $_.Exception.ToString()
        [Console]::Error.WriteLine("[MEDIA SMOKE] process supervisor dispose failed: $supervisorDisposeDiagnostic")
      } finally {
        $supervisorDisposeState = if ($supervisor.IsDisposed) { 'confirmed' } else { 'unconfirmed' }
        if ($supervisorDisposeState -eq 'unconfirmed' -and -not $supervisorDisposeDiagnostic) {
          $supervisorDisposeDiagnostic = @($supervisor.Diagnostics) -join '; '
        }
      }
    }
  }
  [Console]::remove_CancelKeyPress($cancelHandler)
}

$processRecords = @()
if ($null -ne $supervisor) {
  $processRecords = @($supervisor.GetProcessRecords() | ForEach-Object {
    [ordered]@{
      pid = $_.ProcessId
      exitCode = $_.ExitCode
      state = $_.State
      diagnostic = $_.Diagnostic
    }
  })
}
if ($reason -eq 'completed' -and -not $forced -and @($processRecords | Where-Object {
  $_.exitCode -ne 0 -or $_.state -eq 'abnormally_exited'
}).Count -gt 0) {
  $reason = 'child_process_failed'
  $finalExitCode = 1
}
$report = $null
$reportDiagnostics = @()
$reportOperationDiagnostic = $null
$rootLeaseDisposeState = 'not_acquired'
$rootLeaseDisposeDiagnostic = $null
try {
  $fullRoot = [IO.Path]::GetFullPath($candidateRoot)
  $tempRoot = [IO.Path]::GetFullPath($env:TEMP).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  if (-not $fullRoot.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'candidate root is outside TEMP'
  }
  $rootLeaseResult = [MediaSmokeOwnedDirectoryLease]::Open($fullRoot, $rootProof)
  $rootLease = $rootLeaseResult.Lease
  if ($null -eq $rootLease) {
    $rootLeaseDiagnostic = "$($rootLeaseResult.State): $($rootLeaseResult.Diagnostic)"
    throw [IO.IOException]::new($rootLeaseDiagnostic)
  }
  $rootOwnedThisRun = $true

  if ($null -ne $supervisor) { $reportDiagnostics += @($supervisor.Diagnostics) }
  $launcherDiagnostics = @(
    $supervisorCreationDiagnostic
    $supervisorDisposeDiagnostic
    $launcherDiagnostic
    $rootLeaseDiagnostic
  )
  foreach ($diagnostic in $launcherDiagnostics) {
    if (-not [String]::IsNullOrWhiteSpace([string]$diagnostic)) {
      $reportDiagnostics += [string]$diagnostic
    }
  }
  $report = [ordered]@{
    formatVersion = 1
    reason = $reason
    disposableRoot = $candidateRoot
    supervisionReportPath = (Join-Path $candidateRoot 'supervision-report.json')
    startedAt = $startUtc.ToString('o')
    deadlineAt = [DateTimeOffset]::FromUnixTimeMilliseconds($deadlineAtMs).ToString('o')
    stoppedAt = [DateTimeOffset]::UtcNow.ToString('o')
    nodePid = if ($null -ne $supervisor) { $supervisor.RootProcessId } else { $null }
    nodeExitCode = $nodeExitCode
    gracefulStopRequested = $gracefulRequested
    gracefulStopRequestAccepted = $gracefulRequestSucceeded
    shutdownRequestObserved = $shutdownRequestObserved
    forcedTermination = $forced
    forceRequestedAt = $forceRequestedAtUtc
    activePidsBeforeForce = @($activePidsBeforeForce)
    activePidsAfterStop = @($activePidsAfterStop)
    unknownPids = if ($null -ne $supervisor) { @($supervisor.GetUnknownProcessIds()) } else { @() }
    processTree = $processRecords
    rootAssignedToJob = if ($null -ne $supervisor) { $supervisor.RootAssignedToJob } else { $false }
    rootTerminationConfirmed = if ($null -ne $supervisor) { $supervisor.RootTerminationConfirmed } else { $false }
    rootDiagnostic = if ($null -ne $supervisor) { $supervisor.RootDiagnostic } else { $null }
    diagnostics = @($reportDiagnostics)
    supervisorCreationState = $supervisorCreationState
    supervisorDisposeState = $supervisorDisposeState
    supervisorDisposeDiagnostic = $supervisorDisposeDiagnostic
    supervisorDisposed = ($supervisorCreationState -eq 'created' -and
      $supervisorDisposeState -eq 'confirmed' -and
      $null -ne $supervisor -and $supervisor.IsDisposed)
    terminationVerified = $terminationVerified
    disposableRootOwned = $rootOwnedThisRun
    rootIdentityVerified = $rootOwnedThisRun
    rootHandleReleaseState = 'held_during_report_write'
    supervisionReportWritten = $false
  }
  $report.supervisionReportWritten = $true
  $reportJson = $report | ConvertTo-Json -Depth 6
  if (-not $rootLease.WriteReport($reportJson + [Environment]::NewLine)) {
    throw [IO.IOException]::new("root-relative report write failed ($($rootLease.State)): $($rootLease.Diagnostic)")
  }
  $report.supervisionReportWritten = $true
} catch {
  $reportOperationDiagnostic = $_.Exception.ToString()
  if ($null -eq $rootLease -and -not $rootLeaseDiagnostic) {
    $rootLeaseDiagnostic = $reportOperationDiagnostic
  }
  if ($null -ne $report) {
    $report.supervisionReportWritten = $false
    $report.reportWriteDiagnostic = $reportOperationDiagnostic
  }
  if (-not $rootOwnedThisRun -and $reason -eq 'completed') {
    $reason = 'disposable_root_ownership_unverified'
  }
  $finalExitCode = 1
  [Console]::Error.WriteLine("[MEDIA SMOKE] supervision report preparation or write failed: $reportOperationDiagnostic")
} finally {
  if ($null -ne $rootLease) {
    $rootLeaseDisposeState = 'attempted'
    try {
      $rootLease.Dispose()
      $rootHandleReleased = $rootLease.HandleReleased
      if ($rootHandleReleased) {
        $rootLeaseDisposeState = 'confirmed'
      } else {
        $rootLeaseDisposeState = 'unconfirmed'
        $rootLeaseDisposeDiagnostic = $rootLease.Diagnostic
        $finalExitCode = 1
      }
    } catch {
      $rootLeaseDisposeState = 'unconfirmed'
      $rootLeaseDisposeDiagnostic = $_.Exception.ToString()
      $finalExitCode = 1
    }
  }

  if ($null -eq $report) {
    $report = [ordered]@{
      formatVersion = 1
      reason = $reason
      disposableRoot = $candidateRoot
      supervisionReportPath = (Join-Path $candidateRoot 'supervision-report.json')
      startedAt = $startUtc.ToString('o')
      deadlineAt = [DateTimeOffset]::FromUnixTimeMilliseconds($deadlineAtMs).ToString('o')
      stoppedAt = [DateTimeOffset]::UtcNow.ToString('o')
      nodePid = if ($null -ne $supervisor) { $supervisor.RootProcessId } else { $null }
      nodeExitCode = $nodeExitCode
      processTree = $processRecords
      diagnostics = @()
      supervisionReportWritten = $false
    }
  }
  $report.supervisorCreationState = $supervisorCreationState
  $report.supervisorDisposeState = $supervisorDisposeState
  $report.supervisorDisposeDiagnostic = $supervisorDisposeDiagnostic
  $report.supervisorDisposed = ($supervisorCreationState -eq 'created' -and
    $supervisorDisposeState -eq 'confirmed' -and
    $null -ne $supervisor -and $supervisor.IsDisposed)
  $report.disposableRootOwned = $rootOwnedThisRun
  $report.rootIdentityVerified = $rootOwnedThisRun
  $report.rootHandleReleaseState = $rootLeaseDisposeState
  if ($rootLeaseDisposeDiagnostic) {
    $report.rootHandleDiagnostic = $rootLeaseDisposeDiagnostic
    $report.diagnostics = @($report.diagnostics) + @($rootLeaseDisposeDiagnostic)
  }
  if ($reportOperationDiagnostic -and -not $report.reportWriteDiagnostic) {
    $report.reportWriteDiagnostic = $reportOperationDiagnostic
  }
  if ($rootLeaseDiagnostic) {
    $report.diagnostics = @($report.diagnostics) + @($rootLeaseDiagnostic)
  }
  try {
    $reportJson = $report | ConvertTo-Json -Depth 6
    [Console]::Out.WriteLine($reportJson)
  } catch {
    $finalExitCode = 1
    [Console]::Error.WriteLine("[MEDIA SMOKE] final supervision report serialization failed: $($_.Exception.ToString())")
  }
}

exit $finalExitCode
