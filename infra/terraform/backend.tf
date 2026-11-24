terraform {
  backend "s3" {
    bucket       = "afnan-s3-connector"
    key          = "techzu-pos/prod/terraform.tfstate"
    region       = "eu-west-1"
    encrypt      = true
    use_lockfile = true
  }
}
