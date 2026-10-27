|group|cell|prompted / n|wedged|median prompt ms|median location-boot ms|mean CPU %|prompt >45 s (S2 guard)|SIGTERM not honoured in 6 s|SIGKILL ok|
|-|-|-|-|-|-|-|-|-|-|
|bisect-fixed|baseline|3/3|0|464|33|84|0/3|0/3|0/0|
|bisect-fixed|env=parent|3/3|0|205|32|135|0/3|0/3|0/0|
|bisect-fixed|cwd=repo(AGENTS.md ancestor)|3/3|0|614|144|55|0/3|0/3|0/0|
|bisect-fixed|cwd=empty dir|3/3|0|628|39|69|0/3|0/3|0/0|
|bisect-fixed|cwd=clean /tmp dir|3/3|0|636|43|65|0/3|0/3|0/0|
|bisect-fixed|home=warm|3/3|0|294|91|84|0/3|0/3|0/0|
|bisect-fixed|otel=unset|3/3|0|454|25|116|0/3|0/3|0/0|
|bisect-fixed|otel=down|3/3|0|475|43|82|0/3|0/3|0/0|
|bisect-fixed|otel=up +flag|3/3|0|396|30|76|0/3|0/3|0/0|
|bisect-fixed|otel=up svcname (dotfiles)|3/3|0|508|69|64|0/3|0/3|0/0|
|bisect-fixed|client=curl|3/3|0|515|36|68|0/3|0/3|0/0|
|bisect-fixed|host=127.0.0.1|3/3|0|224|35|61|0/3|0/3|0/0|
|bisect-fixed|host=::1|3/3|0|314|51|75|0/3|0/3|0/0|
|bisect-fixed|port=fixed 17900|3/3|0|213|42|64|0/3|0/3|0/0|
|bisect-fixed|stdio=pipe-unread|3/3|0|201|NaN|136|0/3|0/3|0/0|
|bisect-fixed|stdio=pipe-read|3/3|0|597|NaN|66|0/3|0/3|0/0|
|bisect-fixed|stdio=null|3/3|0|413|NaN|68|0/3|0/3|0/0|
|bisect-fixed|stdio=inherit|3/3|0|453|NaN|84|0/3|0/3|0/0|
