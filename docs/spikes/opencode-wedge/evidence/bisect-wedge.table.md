|group|cell|prompted / n|wedged|median prompt ms|median location-boot ms|mean CPU %|prompt >45 s (S2 guard)|SIGTERM not honoured in 6 s|SIGKILL ok|
|-|-|-|-|-|-|-|-|-|-|
|bisect-wedge|baseline|3/3|0|83459|77544|2|3/3|3/3|3/3|
|bisect-wedge|env=parent|3/3|0|79389|73198|2|3/3|3/3|3/3|
|bisect-wedge|cwd=repo(AGENTS.md ancestor)|3/3|0|91822|76485|1|3/3|3/3|3/3|
|bisect-wedge|cwd=empty dir|3/3|0|86629|80128|2|3/3|3/3|3/3|
|bisect-wedge|cwd=clean /tmp dir|3/3|0|60783|52302|2|2/3|3/3|3/3|
|bisect-wedge|home=warm|3/3|0|97405|84563|1|3/3|3/3|3/3|
|bisect-wedge|otel=unset|3/3|0|84814|75950|1|3/3|3/3|3/3|
|bisect-wedge|otel=down|3/3|0|76189|72713|1|3/3|3/3|3/3|
|bisect-wedge|otel=up +flag|3/3|0|118989|64152|1|3/3|2/3|2/2|
|bisect-wedge|otel=up svcname (dotfiles)|3/3|0|108814|96568|4|3/3|3/3|3/3|
|bisect-wedge|client=curl|3/3|0|96722|95932|32|3/3|3/3|3/3|
|bisect-wedge|host=127.0.0.1|3/3|0|47962|40866|3|2/3|3/3|3/3|
|bisect-wedge|host=::1|3/3|0|47432|39002|4|2/3|3/3|3/3|
|bisect-wedge|port=fixed 17900|3/3|0|51630|41979|3|2/3|3/3|3/3|
|bisect-wedge|stdio=pipe-unread|3/3|0|46479|NaN|3|2/3|3/3|3/3|
|bisect-wedge|stdio=pipe-read|3/3|0|48902|NaN|2|2/3|3/3|3/3|
|bisect-wedge|stdio=null|3/3|0|51109|NaN|2|2/3|3/3|3/3|
|bisect-wedge|stdio=inherit|3/3|0|60388|NaN|3|2/3|2/3|2/2|
