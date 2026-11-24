data "aws_route53_zone" "root" {
  name         = var.root_domain
  private_zone = false
}

resource "aws_route53_record" "app" {
  zone_id = data.aws_route53_zone.root.zone_id
  name    = local.fqdn
  type    = "A"
  ttl     = 300
  records = [aws_eip.public.public_ip]
}

resource "aws_route53_record" "caa" {
  zone_id = data.aws_route53_zone.root.zone_id
  name    = local.fqdn
  type    = "CAA"
  ttl     = 300
  records = ["0 issue \"letsencrypt.org\""]
}
