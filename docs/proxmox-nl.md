# Spotweb3 installeren op Proxmox

Je hebt een Proxmox-node met internet nodig, een netwerk met DHCP en ongeveer
2 GB vrij RAM. De installer maakt een **nieuwe Debian 13-container** met
2 CPU-cores en een schijf van 16 GB. Apache, PHP, de downloader-relay en het
automatisch ophalen van spots worden meteen geïnstalleerd.

## 1. Open de Shell van je Proxmox-node

Log in op de Proxmox-webinterface, klik links op je **node** (bijvoorbeeld `pve`)
en kies **Shell**. Voer de opdracht uit als `root`, op de host.

## 2. Plak deze opdracht

```bash
curl -fsSL https://raw.githubusercontent.com/Cyclone47/spotweb3/main/proxmox/quick-install.sh -o /root/spotweb3-install.sh && bash /root/spotweb3-install.sh
```

De installer kiest automatisch een vrij container-ID en downloadt het actuele
Debian 13-template en de Spotweb3-broncode. Je hoeft niets vooraf te downloaden
of vanaf je eigen computer te kopiëren.

- Zijn er meerdere opslaglocaties? Kies de gewenste naam, of druk op **Enter**
  voor de voorgestelde keuze. Containeropslag en templateopslag kunnen verschillen;
  `local-lvm` en `local` is bijvoorbeeld normaal.
- Controleer het overzicht en druk op **Enter** om te installeren.
- Wacht tot **Ready** verschijnt. De installatie kan enkele minuten duren.

Standaard gebruikt hij netwerkbridge `vmbr0` en DHCP. Heeft jouw netwerk een
andere bridge, gebruik dan de aangepaste opdracht onderaan.

## 3. Open de getoonde link

Aan het einde verschijnt bijvoorbeeld `https://192.168.1.120/?page=setup`,
met het echte IP-adres van jouw container.
Open **de link die jouw installer toont** op een computer in hetzelfde netwerk.
Open je Spotweb eerst via HTTP, dan biedt de eerste stap **Yes, use HTTPS on port
443** aan. Kies daarna **Continue to HTTPS** voordat je je account- en
Usenet-gegevens invult.

De container heeft een eigen lokaal certificaat. Je browser kan daarom een
waarschuwing tonen. Voor je eigen installatie kun je via **Geavanceerd → Doorgaan**
verdergaan als je browser dat toestaat. De wizard controleert daarna of de
benodigde browserfuncties beschikbaar zijn. Blijven ze geblokkeerd, of wil je de
waarschuwing verwijderen? Open de certificaathulp in de wizard: download het
publieke CA-certificaat en vertrouw dat op je computer. Voor Windows staan de
stappen daar uitgeschreven. Doe dit alleen voor je eigen Spotweb-installatie.

Stel daarna je Spotweb-beheeraccount en Usenet-servergegevens in.

In **Admin Center → Overview → Automatic spot retrieval** kies je hoe vaak
nieuwe spots worden opgehaald, bijvoorbeeld iedere 5, 15 of 30 minuten.
De container en achtergrondservices starten automatisch mee met Proxmox.

**Voor Download in browser gebruik je desktop Chrome of Edge.** HTTPS op poort
443 is nu ingebouwd; een aparte reverseproxy is niet nodig. Heb je al een proxy
met een vertrouwd certificaat, dan kun je die blijven gebruiken en doorsturen
naar poort 80, inclusief WebSockets op `/nntp-relay-ws`. Normaal bladeren en
andere downloadmethodes werken ook via HTTP.

De privésleutels blijven op de server in `/etc/spotweb/tls`, leesbaar voor root.
Iedere installatie heeft eigen sleutels. De server controleert dagelijks of het
servercertificaat moet worden vernieuwd; de lokale CA blijft daarbij gelijk.
Neem deze map mee in je normale containerback-up. Bij een gewijzigd IP-adres
voer je binnen de container `php /opt/spotweb/bin/configure-https.php /opt/spotweb`
en `systemctl reload apache2` uit om het certificaat bij te werken.

## Wachtwoorden en beheer

Er is geen CentOS nodig; deze installer gebruikt Debian. Er wordt geen gedeeld
Linux- of Spotweb-wachtwoord ingesteld. Het **Spotweb-wachtwoord kies je zelf in
de wizard**. Voor beheer van Linux voer je op de Proxmox-host dit uit:

```bash
pct enter 120
```

Vervang `120` door het getoonde container-ID. Hiervoor is geen Linux-rootwachtwoord
nodig. Wil je er toch een instellen, voer dan binnen die container `passwd` uit.
Een SSH-sleutel kun je bij installatie meegeven met `--ssh-key`.

## Volledig unattended of eigen instellingen

Zonder vragen, met de getoonde standaardkeuzes:

```bash
curl -fsSL https://raw.githubusercontent.com/Cyclone47/spotweb3/main/proxmox/quick-install.sh -o /root/spotweb3-install.sh && bash /root/spotweb3-install.sh --yes
```

Eigen opslag, bridge of capaciteit (pas de namen aan jouw Proxmox aan):

```bash
bash /root/spotweb3-install.sh --yes --storage local-zfs --template-storage local --bridge vmbr1 --memory 4096 --disk 32
```

Optioneel: `--id 120`, `--hostname spotweb`, `--cores 2`,
`--ssh-key /root/.ssh/id_ed25519.pub`. Met `--dry-run` controleer je de keuzes
zonder iets te downloaden of aan te maken. De installer maakt altijd een nieuwe
container; opnieuw uitvoeren werkt geen bestaande installatie bij.

## Als de installatie stopt

De foutmelding blijft in de Shell staan. Een aangemaakte container blijft bestaan
zodat je hem kunt inspecteren met `pct enter ID`. Bij netwerkproblemen controleer
je of de gekozen bridge DHCP, DNS en internettoegang biedt. Maak na een geslaagde
installatie een Proxmox-back-up; de database staat in `/var/lib/spotweb` binnen
de container.

Zie de [uitgebreide handleiding](docker-and-proxmox.md#services-and-data) voor
services, logboeken, back-ups en updates. De Debian-installatie is getest op
Debian 12 en 13; een volledige installatie op een echte Proxmox-host moet nog
in de praktijk worden bevestigd.
