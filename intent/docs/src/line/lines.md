# Product lines

> Define a product line once: who it serves, the end every product in it serves, and the choices every product starts from. It sits inside mission control, and each product line has its own intent studio.

## TL;DR

A product line is a family of products that serve the same people under the same rules. It sits inside mission control, and a family holds many products, each built separately on the line. Defining the family once (who it serves, its end in mind, compliance, how people sign in, where reports go, the API, use tracking) means every product started in it begins from those {{lines.choices}} choices. The family's intent studio then asks only what is different about the new product.

{{diagram:lines}}

## Explain it simply

A furniture company makes a family of school shelves. Every school shelf uses the same safe finish, the same rounded corners and the same height limits. When a new school orders one, nobody asks about the finish again; they ask only how many shelves and how tall. The family remembers the rest.

## Engineer

### What a product line holds

| Field | Used for |
| --- | --- |
| Name | Grouping its products everywhere they appear |
| Who it serves | The people every product in it is for |
| The end it serves | Written into each new product's schematic as its end in mind |
| Compliance | The frameworks every product lives under: chosen from {{frameworks.names}} |
| Sign-in | The identity provider |
| Report a problem | In every environment, testing only, or off |
| Tickets and chat | Where reports and notices go |
| API | Closed, open for some features, or open for all |
| Use tracking | Counts only, with consent, or off |

{{diagram:line-choices}}

### Starting a product in a product line

A new product opens in the intent studio with its title, the product line's end in mind under *The end in mind*, an empty first line under *What it should do* with the cursor on it, and the family's choices on its spec sheet. Each choice can still be changed for that product alone in product engineering. A product can also join a product line later without changing its own choices.

### Where it is kept

Product lines and the library of products are kept in the browser beside the studio's work. The product open in the studio is one record; every other product is kept whole and can be opened again from its product line. A registry held centrally does not exist yet, and the page says so: it is the first thing mission control needs from this area.

## Architect

A product line is the first fixture a person makes, and the one that compounds fastest: every product started in it skips the same decisions, and every decision skipped is one that cannot be made inconsistently.

- **Defaults, never locks.** A product line's choices are where products start, not rules they cannot leave. A product that departs from its family says so on its own spec sheet, where product engineering sees it.
- **The end in mind is shared.** A family of products that serve one end can be measured together: mission control can show whether a product line, not just a product, is doing its job.
- **Compliance is decided once per family.** A product line under FERPA puts every product in it under FERPA, so no product in it forgets.
- **Each family has a reference system.** Every product is measured against something that already exists: Files, the first product, against Nextcloud.
- **Product lines are the unit of reuse above parts.** Parts are reused across every product; product lines are reused across products that serve the same people.
