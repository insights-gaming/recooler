# Migrating to recooler 0.1

- Custom-pattern parameters now always sort before plain parameters at the same position
  (static < custom pattern < plain param < catch-all). In 0.0.27, parameter names could put
  a plain parameter first and make a regex route unreachable for matching input.
