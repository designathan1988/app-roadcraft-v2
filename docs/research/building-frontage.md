# Building frontage placement

[Unity's contact separation documentation](https://docs.unity3d.com/kr/6000.0/ScriptReference/ContactPoint-separation.html) distinguishes touching geometry from a positive gap. [The GDC presentation on city simulation](https://www.gdcvault.com/play/1034347/We-Built-This-City-on) treats building-to-building and network connections as explicit city-system relationships.

Roadcraft's geometric road validation already owns a 0.02-unit clearance from the back of the footway. The road and corner snapping added another 0.1 unit, while generated town frontage used a separate 0.12-unit gap. These were redundant separations, so snapping and town generation now read the same validation clearance. A separate six-unit corner-snap reach still limits when a building is pulled to the second street; it requires a placement-design change, not another clearance constant.
