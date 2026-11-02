# Run from the repository root to regenerate the independent 105-digit oracle.
# Only Python's standard Decimal implementation is used, never the JS helper.
import decimal,math,json
from decimal import Decimal as D
from pathlib import Path
decimal.getcontext().prec=105
cases=[]
for hr,ar,rho,line,side,giver,water,mechanic,basis in [
(1.4,1.1,0.,'0','HOME','home',.95,'ASIAN_SPLIT','SETTLED_PRINCIPAL'),
(1.4,1.1,0.,'0','AWAY','home',.95,'ASIAN_SPLIT','SETTLED_PRINCIPAL'),
(1.5,1.1,.1,'0.25','HOME','home',.93,'ASIAN_SPLIT','SETTLED_PRINCIPAL'),
(1.5,1.1,-.1,'0.75','AWAY','home',1.07,'ASIAN_SPLIT','LOSS_PRINCIPAL'),
(1.5,1.1,.1,'1/1.5','HOME','away',.93,'ASIAN_SPLIT','TOTAL_PRINCIPAL'),
(1.5,1.1,.1,'1+20','HOME','home',.93,'CREDIT_BOUNDARY','SETTLED_PRINCIPAL'),
(1.5,1.1,.1,'1-50','AWAY','home',1.07,'CREDIT_BOUNDARY','SETTLED_PRINCIPAL'),
(.001,.002,.1,'0','HOME','home',.95,'ASIAN_SPLIT','SETTLED_PRINCIPAL'),
(30.,25.,.0003,'3.5','HOME','home',.95,'ASIAN_SPLIT','SETTLED_PRINCIPAL'),
(25.,30.,-.01,'3+25','AWAY','home',.95,'CREDIT_BOUNDARY','NONE'),
(30.,30.,0.,'0','HOME','home',.95,'ASIAN_SPLIT','SETTLED_PRINCIPAL'),
(1.4,1.1,0.,'50','HOME','home',.95,'ASIAN_SPLIT','SETTLED_PRINCIPAL'),
(1.4,1.1,0.,'50','AWAY','home',.95,'ASIAN_SPLIT','SETTLED_PRINCIPAL'),
]:
 h,a,r=D.from_float(hr),D.from_float(ar),D.from_float(rho)
 w=D.from_float(water); rb=D.from_float(0. if basis=='NONE' else .01)
 scale=(-(h+a)).exp(); correction=scale*h*a*r
 # Independent high precision Skellam Bessel-series formula, not rectangle PMF.
 def pmf(k):
  rate=h if k>=0 else a; n=abs(k); term=rate**n/D(math.factorial(n)); total=term
  for j in range(1,501):
   term*=h*a/(D(j)*D(j+n));total+=term
   if j>60 and abs(scale*term)<D('1e-110'):break
  p=scale*total
  if k==0:p-=2*correction
  elif abs(k)==1:p+=correction
  return p
 def fractions(k):
  m=D(k if side=='HOME' else -k);giving=giver==('home' if side=='HOME' else 'away')
  if mechanic=='CREDIT_BOUNDARY':
   import re
   q=re.fullmatch(r'(\d+(?:\.\d+)?)([+-]\d+|平)?',line);v=D(q[1]);delta=m-v if giving else m+v
   ref=D(q[2])/100 if q[2] not in (None,'平') else D(0)
   f=ref*(1 if giving else -1) if delta==0 else D(1 if delta>0 else -1)
   win,loss=max(D(0),f),max(D(0),-f)
  else:
   vals=[D(x) for x in line.split('/')]
   if len(vals)==1 and vals[0]*2!=int(vals[0]*2):v=vals[0];vals=[v-D('.25'),v+D('.25')]
   win=loss=D(0)
   for v in vals:
    delta=m-v if giving else m+v
    win+=D(delta>0)/len(vals);loss+=D(delta<0)/len(vals)
  # Match the explicitly disclosed binary64 settlement-fraction input scope.
  return D.from_float(float(win)),D.from_float(float(loss))
 probs={k:D(0) for k in ['FULL_WIN','PARTIAL_WIN','PUSH','PARTIAL_LOSS','FULL_LOSS']};ev={k:D(0) for k in ['gross','rebate','net']}
 for k in range(-180,181):
  p=pmf(k);win,loss=fractions(k)
  outcome='FULL_WIN' if win==1 else 'FULL_LOSS' if loss==1 else 'PARTIAL_WIN' if win>0 else 'PARTIAL_LOSS' if loss>0 else 'PUSH'
  probs[outcome]+=p;g=win*w-loss
  base=D(1) if basis=='TOTAL_PRINCIPAL' else win+loss if basis=='SETTLED_PRINCIPAL' else loss if basis=='LOSS_PRINCIPAL' else D(0)
  re=rb*base;ev['gross']+=p*g;ev['rebate']+=p*re;ev['net']+=p*(g+re)
 cases.append(dict(homeRate=hr,awayRate=ar,rho=rho,line=line,side=side,lineSide=giver,water=water,mechanic=mechanic,rebateBasis=basis,ev={k:str(v) for k,v in ev.items()},probabilities={k:str(v) for k,v in probs.items()}))
Path('scripts/fixtures/soccer/tails/difference-decimal-oracle.json').write_text(json.dumps(dict(method='PYTHON_DECIMAL_105_DIGITS_SKELLAM_BESSEL_SERIES_PLUS_EXPLICIT_DC_CORRECTION',parameterScope='DECIMAL_FROM_FLOAT_EXACT_BINARY64_INPUTS',seriesAbsoluteTermStop='1e-110',differenceWindow=[-180,180],cases=cases),indent=2)+'\n')
