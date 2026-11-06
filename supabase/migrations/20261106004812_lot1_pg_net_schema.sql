-- pg_net hors du schéma public (advisor 0014). Ses fonctions restent dans le schéma net.
-- Sur une base neuve, la migration précédente l'installe déjà dans extensions : no-op.
drop extension if exists pg_net;
create extension pg_net with schema extensions;
