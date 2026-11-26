# Weather and roads

On a day when the weather changes how a student gets to class or work, the Advocate says so before they leave:
what is coming, how much earlier to leave for the first class or shift, and what to bring. On ordinary days it
says nothing.

```mermaid
flowchart LR
  zip[Student's ZIP] --> town[Rounded to the town, about a kilometer]
  town --> egress{Egress block: api.weather.gov only}
  egress --> points[Points lookup] --> link{Forecast link on api.weather.gov?}
  link -- no --> quiet[Say nothing]
  link -- yes --> fc[Today's forecast]
  fc --> impact{What does it mean for the trip?}
  impact -- ordinary --> quiet
  impact -- rain, storms, very cold or hot --> note[Note: leave a little earlier, bring this]
  impact -- snow or ice --> heads[Heads-up: leave 25 to 30 minutes earlier]
  first[First class or shift today] --> note & heads
```

| Weather | Severity | Leave earlier |
| --- | --- | --- |
| Ice, freezing rain, sleet | plan around it | 30 minutes |
| Snow, likely | plan around it | 25 minutes |
| Storms or heavy rain | worth a note | 10 to 15 minutes |
| 10 degrees or colder | worth a note | 10 minutes |
| 95 degrees or hotter | worth a note | bring water |
| Anything else | nothing said | |

Nothing about the student leaves: only the town's coordinates. If the weather service is down, slow or points
anywhere unexpected, the Advocate says nothing rather than guess.

## Verified by

<!-- verified-by:start -->
- [`apps/advocate/test/weather.test.ts`](../../apps/advocate/test/weather.test.ts) (10 test definitions)
<!-- verified-by:end -->
