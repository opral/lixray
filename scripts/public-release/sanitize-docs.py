# git-filter-repo blob callback; applies only to these two document headings.
import re
if blob.data.startswith(b'# Lix runtime recovery stall\n'):
    text = blob.data.decode('utf-8')
    lines = []
    for line in text.splitlines():
        if line.startswith('- **Affected workspace:**'):
            line = '- **Affected workspace:** One production workspace (identifier omitted)'
        elif line.startswith('- **Affected lix ID:**'):
            continue
        elif line.startswith('- **PostHog issue:**'):
            line = '- **Incident tracking:** Internal telemetry reference omitted from the public report'
        lines.append(line)
    blob.data = ('\n'.join(lines) + '\n').encode()
elif blob.data.startswith(b'# Telemetry catalog\n'):
    text = blob.data.decode('utf-8')
    text = '\n'.join(line for line in text.splitlines() if not line.startswith(('Audit date:', 'Production evidence:'))) + '\n'
    text = text.replace('## Production custom-event cleanup', '## Legacy event migration')
    if 'The production project contained' in text and '| Observed event' in text:
        start = text.index('The production project contained')
        end = text.index('| Observed event', start)
        text = text[:start] + 'Use this mapping when updating existing event definitions, destinations, and\nsaved queries to the canonical taxonomy. Production usage counts and internal\nanalytics identifiers are omitted.\n\n' + text[end:]
    if '| Observed event' in text:
        start = text.index('| Observed event')
        end = text.index('\n\n', start)
        rows = []
        for line in text[start:end].splitlines():
            cols = line.split('|')
            rows.append('|' + cols[1] + '|' + cols[3] + '|' if len(cols) == 5 else line)
        text = text[:start] + '\n'.join(rows) + text[end:]
    text = text.replace('Names declared in source but not yet observed during the live window follow the\nsame strip-prefix rule:', 'Other legacy names follow the same strip-prefix rule:')
    text = re.sub(r'Change PostHog action \d+ and signup insights', 'Change the signup action and insights', text)
    blob.data = text.encode()
