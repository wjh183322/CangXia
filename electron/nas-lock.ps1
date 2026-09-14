$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
function Send-Json($value) { [Console]::WriteLine(($value | ConvertTo-Json -Compress -Depth 12)); [Console]::Out.Flush() }
$stream = $null
try {
  $initial = [Console]::ReadLine() | ConvertFrom-Json
  $logPath = [IO.Path]::GetFullPath([string]$initial.path)
  try { $stream = [IO.FileStream]::new($logPath,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::Read,4096,[IO.FileOptions]::WriteThrough) }
  catch [IO.IOException] { Send-Json @{event='busy';message='媒体库已被其他电脑占用，或写入锁暂不可用'}; exit 0 }
  if($stream.Length -lt 256) { $stream.SetLength(256) }
  $offset = [Math]::Max(256,$stream.Length-65536)
  $stream.Position=$offset
  $bytes=[byte[]]::new([int]($stream.Length-$offset)); $read=$stream.Read($bytes,0,$bytes.Length)
  $tail=[Text.Encoding]::UTF8.GetString($bytes,0,$read)
  $last=$null
  $lines=$tail.Split("`n")
  for($i=0;$i -lt $lines.Length-1;$i++){try{$entry=$lines[$i] | ConvertFrom-Json;if($entry.kind -eq 'commit'){$last=$entry}}catch{}}
  $revision=0; if($last){$revision=[long]$last.revision}
  # All committed head records and heartbeats use this same, server-locked handle.
  # Never reopen it after a failed I/O: that would allow a stale writer to recover silently.
  function Pulse {
    $header=@{device=[string]$initial.device;token=[string]$initial.token;time=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json -Compress
    $buffer=[byte[]]::new(256);$encoded=[Text.Encoding]::UTF8.GetBytes($header);if($encoded.Length -gt 250){throw '写入设备名称过长'}
    [Array]::Copy($encoded,$buffer,$encoded.Length);$stream.Position=0;$stream.Write($buffer,0,256);$stream.Flush($true)
  }
  Pulse
  Send-Json @{event='ready';revision=$revision;head=$last}
  $reader=[IO.StreamReader]::new([Console]::OpenStandardInput(),[Text.UTF8Encoding]::new($false))
  $pending=$reader.ReadLineAsync();$lastPulse=[DateTime]::UtcNow
  while($true){
    if($pending.IsCompleted){
      $line=$pending.GetAwaiter().GetResult();if($null -eq $line){break}
      $command=$line | ConvertFrom-Json
      if($command.action -eq 'close'){Send-Json @{id=$command.id;ok=$true};break}
      Pulse
      if($command.action -eq 'commit'){
        if([long]$command.expected -ne $revision){throw 'NAS 记录版本已变化，已拒绝覆盖'}
        if([string]$command.file -notmatch '^[a-f0-9-]+\.sqlite$' -or [string]$command.sha -notmatch '^[a-f0-9]{64}$'){throw '版本文件无效'}
        $snapshot=[IO.Path]::Combine([IO.Path]::GetDirectoryName($logPath),'versions',[string]$command.file)
        $hashStream=[IO.File]::OpenRead($snapshot);$algorithm=[Security.Cryptography.SHA256]::Create()
        try{$actual=[BitConverter]::ToString($algorithm.ComputeHash($hashStream)).Replace('-','').ToLower()}finally{$hashStream.Dispose();$algorithm.Dispose()}
        if($actual -ne [string]$command.sha){throw 'NAS 版本文件校验失败'}
        $revision++
        $record=@{kind='commit';revision=$revision;file=[string]$command.file;sha=[string]$command.sha;time=[DateTime]::UtcNow.ToString('o')}
        # Prefix newline separates a torn tail left by a failed previous writer.
        $recordBytes=[Text.Encoding]::UTF8.GetBytes("`n"+($record | ConvertTo-Json -Compress)+"`n")
        $stream.Position=$stream.Length;$stream.Write($recordBytes,0,$recordBytes.Length);$stream.Flush($true)
        Send-Json @{id=$command.id;ok=$true;head=$record}
      }else{Send-Json @{id=$command.id;ok=$true;revision=$revision}}
      $pending=$reader.ReadLineAsync()
    }
    if(([DateTime]::UtcNow-$lastPulse).TotalSeconds -ge 2){Pulse;Send-Json @{event='heartbeat'};$lastPulse=[DateTime]::UtcNow}
    Start-Sleep -Milliseconds 100
  }
}catch{Send-Json @{event='lost';message=$_.Exception.Message};exit 1}
finally{if($stream){$stream.Dispose()}}
