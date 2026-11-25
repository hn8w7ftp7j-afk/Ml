export const SOCCER_MATCH_CARD_MEDIA_TYPE = 'application/vnd.soccer.match-card+json';

function payoffSummary(payoff) {
  if (!Array.isArray(payoff?.rows)) return payoff;
  const { rows, ...summary } = payoff;
  return { ...summary, scorelineRowCount: rows.length };
}

// The card renders aggregate settlement probabilities and EV. Detailed
// score-by-score payouts remain in the immutable revision and full JSON API.
export function soccerMatchCard(snapshot) {
  if (!Array.isArray(snapshot?.directions)) return snapshot;
  return { ...snapshot, directions: snapshot.directions.map(direction => {
    if (!Array.isArray(direction?.quotes)) return direction;
    return { ...direction, quotes: direction.quotes.map(quote => !quote ? quote : ({
      ...quote,
      ...(quote.payoff && { payoff: payoffSummary(quote.payoff) }),
      ...(quote.scoring?.conditionalPayoff && { scoring: {
        ...quote.scoring, conditionalPayoff: payoffSummary(quote.scoring.conditionalPayoff),
      } }),
    })) };
  }) };
}
